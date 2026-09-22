// MVP VERSION — same security model as server.js, but only needs Postgres.
// Good enough to launch and test with real users; migrate to the Redis
// version later once you have traffic that needs the extra speed/locking.

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const INITDATA_MAX_AGE_SECONDS = 3600;

function authenticateTelegram(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing initData header' });
    }

    const initDataStr = authHeader.split(' ')[1];
    const urlParams = new URLSearchParams(initDataStr);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const params = Array.from(urlParams.entries())
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(params).digest('hex');

    if (calculatedHash !== hash) {
        return res.status(403).json({ error: 'Forbidden: Invalid hash verification' });
    }

    const authDate = parseInt(urlParams.get('auth_date'), 10);
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (!authDate || ageSeconds > INITDATA_MAX_AGE_SECONDS) {
        return res.status(403).json({ error: 'Forbidden: initData expired, please reopen the app' });
    }

    req.telegramUser = JSON.parse(urlParams.get('user'));
    req.startParam = urlParams.get('start_param');
    next();
}

async function getDbUser(client, telegramId) {
    const res = await client.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return res.rows[0] || null;
}

// -------------------------------------------------------------
// 1. USER SYNC
// -------------------------------------------------------------
app.post('/api/user/sync', authenticateTelegram, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tgUser = req.telegramUser;
        let user = await getDbUser(client, tgUser.id);

        if (!user) {
            let referrerId = null;
            if (req.startParam && req.startParam.startsWith('ref_')) {
                const refTgId = parseInt(req.startParam.replace('ref_', ''), 10);
                if (refTgId !== tgUser.id) {
                    const refRes = await client.query('SELECT id FROM users WHERE telegram_id = $1', [refTgId]);
                    if (refRes.rows.length > 0) referrerId = refRes.rows[0].id;
                }
            }
            const insertRes = await client.query(
                `INSERT INTO users (telegram_id, username, first_name, referred_by)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [tgUser.id, tgUser.username, tgUser.first_name, referrerId]
            );
            user = insertRes.rows[0];
            if (referrerId) {
                await client.query(
                    `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [referrerId, user.id]
                );
            }
        }

        const balRes = await client.query(
            `SELECT COALESCE(SUM(amount), 0.00) as balance FROM transactions WHERE user_id = $1`, [user.id]
        );
        const balance = parseFloat(balRes.rows[0].balance);

        const refCountRes = await client.query(
            `SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1 AND is_qualified = TRUE`, [user.id]
        );
        const qualifiedReferrals = parseInt(refCountRes.rows[0].count, 10);

        const settingsRes = await client.query(`SELECT key, value FROM platform_settings`);
        const settings = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]));
        const minWithdraw = parseFloat(settings.MIN_WITHDRAWAL_AMOUNT || '3.00');
        const minQualRef = parseInt(settings.MIN_QUALIFIED_REFERRALS || '2', 10);

        await client.query('COMMIT');

        res.json({
            user: {
                id: user.id, telegramId: user.telegram_id, username: user.username,
                firstName: user.first_name,
                referralLink: `https://t.me/YourBotName_bot?start=ref_${user.telegram_id}`
            },
            financials: {
                balance, qualifiedReferrals,
                isEligibleForPayout: balance >= minWithdraw && qualifiedReferrals >= minQualRef,
                requirements: { minWithdrawal: minWithdraw, minQualifiedReferrals: minQualRef }
            }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Sync error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------
// 2. START TASK — attempt stored in Postgres instead of Redis
// -------------------------------------------------------------
app.post('/api/tasks/:taskId/start', authenticateTelegram, async (req, res) => {
    const taskId = parseInt(req.params.taskId, 10);
    if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'Invalid task id' });

    const client = await pool.connect();
    try {
        const user = await getDbUser(client, req.telegramUser.id);
        if (!user) return res.status(404).json({ error: 'Call /user/sync first' });
        if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'Account suspended' });

        const taskRes = await client.query('SELECT * FROM tasks WHERE id = $1 AND is_active = TRUE', [taskId]);
        if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Task not available' });
        const task = taskRes.rows[0];

        const doneRes = await client.query(
            'SELECT id FROM task_completions WHERE user_id = $1 AND task_id = $2', [user.id, taskId]
        );
        if (doneRes.rows.length > 0) return res.status(400).json({ error: 'Task already completed' });

        const poolRes = await client.query(
            'SELECT id, question_text, options, correct_index FROM task_questions WHERE task_id = $1 AND is_active = TRUE',
            [taskId]
        );
        if (poolRes.rows.length === 0) return res.status(500).json({ error: 'Task misconfigured: no questions' });

        const shuffledPool = [...poolRes.rows].sort(() => Math.random() - 0.5);
        const selected = shuffledPool.slice(0, Math.min(task.questions_per_attempt, shuffledPool.length));

        const clientQuestions = [];
        const answerKey = {};
        for (const q of selected) {
            const optionOrder = q.options.map((opt, i) => ({ opt, i })).sort(() => Math.random() - 0.5);
            clientQuestions.push({ id: q.id, text: q.question_text, options: optionOrder.map(o => o.opt) });
            answerKey[q.id] = optionOrder.findIndex(o => o.i === q.correct_index);
        }

        const attemptToken = crypto.randomBytes(24).toString('hex');
        await client.query(
            `INSERT INTO task_attempts
             (attempt_token, user_id, task_id, video_duration_seconds, min_watch_fraction,
              min_correct_to_pass, reward_amount, answer_key, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '10 minutes')`,
            [attemptToken, user.id, taskId, task.video_duration_seconds, task.min_watch_fraction,
             task.min_correct_to_pass, task.reward_amount, JSON.stringify(answerKey)]
        );

        res.json({
            attemptToken,
            videoUrl: task.video_url,
            videoDurationSeconds: parseFloat(task.video_duration_seconds),
            questions: clientQuestions
        });
    } catch (err) {
        console.error('Task start error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------
// 3. COMPLETE TASK — server re-grades from the stored attempt row
// -------------------------------------------------------------
app.post('/api/tasks/complete', authenticateTelegram, async (req, res) => {
    const { attemptToken, maxTimeReached, seekedAway, answers } = req.body;
    if (!attemptToken || typeof maxTimeReached !== 'number' || !Array.isArray(answers)) {
        return res.status(400).json({ error: 'Malformed request' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the attempt row so it can't be used twice concurrently
        const attemptRes = await client.query(
            `SELECT * FROM task_attempts WHERE attempt_token = $1 AND used = FALSE AND expires_at > NOW() FOR UPDATE`,
            [attemptToken]
        );
        if (attemptRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Attempt expired, already used, or invalid.' });
        }
        const attempt = attemptRes.rows[0];

        // Mark used immediately — one-time use, no replay
        await client.query('UPDATE task_attempts SET used = TRUE WHERE attempt_token = $1', [attemptToken]);

        const user = await getDbUser(client, req.telegramUser.id);
        if (!user || user.id !== attempt.user_id) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Attempt does not belong to this user' });
        }
        if (user.status !== 'ACTIVE') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Account suspended' });
        }

        const compRes = await client.query(
            'SELECT id FROM task_completions WHERE user_id = $1 AND task_id = $2',
            [user.id, attempt.task_id]
        );
        if (compRes.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Task already completed' });
        }

        const watchFraction = Math.min(1, maxTimeReached / parseFloat(attempt.video_duration_seconds));
        const watchedEnough = watchFraction >= parseFloat(attempt.min_watch_fraction);
        const noSeeking = seekedAway === false;

        let correctCount = 0;
        for (const a of answers) {
            const correctIndex = attempt.answer_key[a.questionId];
            if (correctIndex !== undefined && a.selectedIndex === correctIndex) correctCount++;
        }
        const enoughCorrect = correctCount >= attempt.min_correct_to_pass;
        const passed = watchedEnough && noSeeking && enoughCorrect;

        if (!passed) {
            await client.query('COMMIT'); // keep the "used=TRUE" update; nothing else to save
            return res.status(200).json({
                success: false,
                reason: !watchedEnough ? 'INSUFFICIENT_WATCH_TIME'
                    : !noSeeking ? 'SEEKING_DETECTED' : 'INCORRECT_ANSWERS'
            });
        }

        const completionInsert = await client.query(
            `INSERT INTO task_completions (user_id, task_id, reward_claimed) VALUES ($1, $2, $3) RETURNING id`,
            [user.id, attempt.task_id, attempt.reward_amount]
        );
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, reference_id, description)
             VALUES ($1, $2, 'TASK_REWARD', $3, $4)`,
            [user.id, attempt.reward_amount, completionInsert.rows[0].id, `Completed task #${attempt.task_id}`]
        );
        await client.query(
            `UPDATE referrals SET is_qualified = TRUE, qualified_at = NOW()
             WHERE referred_id = $1 AND is_qualified = FALSE`,
            [user.id]
        );

        await client.query('COMMIT');
        res.json({ success: true, rewardClaimed: parseFloat(attempt.reward_amount) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Task completion error:', err);
        res.status(500).json({ error: 'Transaction failed' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------
// 4. WITHDRAWAL REQUEST
// -------------------------------------------------------------
app.post('/api/withdraw/request', authenticateTelegram, async (req, res) => {
    const { paymentMethodId, accountDetails } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await getDbUser(client, req.telegramUser.id);
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

        const balRes = await client.query(
            'SELECT COALESCE(SUM(amount), 0.00) as balance FROM transactions WHERE user_id = $1', [user.id]
        );
        const currentBalance = parseFloat(balRes.rows[0].balance);

        const refRes = await client.query(
            'SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1 AND is_qualified = TRUE', [user.id]
        );
        const qualifiedCount = parseInt(refRes.rows[0].count, 10);

        const settingsRes = await client.query(`SELECT key, value FROM platform_settings`);
        const settings = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]));
        const minWithdraw = parseFloat(settings.MIN_WITHDRAWAL_AMOUNT || '3.00');
        const minQualRef = parseInt(settings.MIN_QUALIFIED_REFERRALS || '2', 10);

        if (currentBalance < minWithdraw) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Minimum withdrawal is $${minWithdraw}` });
        }
        if (qualifiedCount < minQualRef) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Requires at least ${minQualRef} qualified referrals.` });
        }

        const withdrawRes = await client.query(
            `INSERT INTO withdrawals (user_id, amount, payment_method_id, account_details, status)
             VALUES ($1, $2, $3, $4, 'PENDING') RETURNING id`,
            [user.id, currentBalance, paymentMethodId, accountDetails]
        );
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, reference_id, description)
             VALUES ($1, $2, 'WITHDRAWAL_LOCK', $3, 'Withdrawal request pending execution')`,
            [user.id, -currentBalance, withdrawRes.rows[0].id]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Withdrawal request submitted' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Withdrawal error:', err);
        res.status(500).json({ error: 'Failed to process request' });
    } finally {
        client.release();
    }
});

app.listen(process.env.PORT || 3000, () => console.log('MVP backend running'));
