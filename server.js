const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// CORS設定
app.use(cors({
    origin: 'http://127.0.0.1:5500',  // フロントエンドのURLに合わせて変更
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// PostgreSQLの接続設定
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'postgres',
    password: 'password',
    port: 5432,
});

// bodyParserを使用
app.use(bodyParser.json());

const upload = multer({
    dest: 'uploads/', // 画像を保存するディレクトリ
    limits: { fileSize: 5 * 1024 * 1024 }, // 最大ファイルサイズ 5MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
            return cb(new Error('画像ファイルはPNG、JPG、JPEGのみです'));
        }
        cb(null, true);
    },
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, 'uploads/');  // 保存先のディレクトリ
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);  // 元のファイルの拡張子を取得
            const filename = Date.now() + ext;  // タイムスタンプ + 拡張子を使用
            cb(null, filename);  // 新しいファイル名を決定
        }
    })
});


// JWT設定
const secretKey = 'your_secret_key';

// アカウント登録API
app.post('/api/v1/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const checkUser = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

        if (checkUser.rows.length > 0) {
            return res.status(409).json({ error: 'このユーザー名は既に使われています' });
        }

        const result = await pool.query(
            'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
            [username, hashedPassword]
        );
        res.status(201).json({ message: 'アカウント作成成功', id: result.rows[0].id });
    } catch (error) {
        console.error('アカウント作成エラー:', error);
        res.status(500).json({ error: 'アカウント作成に失敗しました' });
    }
});

// ログインAPI
app.post('/api/v1/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'ユーザーが見つかりません' });
        }

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'パスワードが間違っています' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, secretKey, { expiresIn: '1d' });
        res.status(200).json({ message: 'ログイン成功', token });
    } catch (error) {
        console.error('ログインエラー:', error);
        res.status(500).json({ error: 'ログインに失敗しました' });
    }
});

// タイムライン取得API
app.get('/api/v1/timelines/public', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT p.id, p.content, p.created_at, p.image_url, u.username FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC'
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('タイムライン取得エラー:', error);
        res.status(500).json({ error: 'タイムライン取得に失敗しました' });
    }
});

// 投稿作成API
app.post('/api/v1/statuses', upload.single('image'), async (req, res) => {
    const { content } = req.body;
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }

    try {
        const decoded = jwt.verify(token, secretKey);
        const userId = decoded.id;

        let imageUrl = null;
        if (req.file) {
            // 画像URLを作成（`http://localhost:3000/uploads/<filename>`）
            imageUrl = `http://localhost:3000/uploads/${req.file.filename}`;
        }

        // 画像URLが提供されない場合のエラーハンドリング
        if (!imageUrl) {
            return res.status(400).json({ error: '画像が必要です' });
        }

        const result = await pool.query(
            'INSERT INTO posts (content, user_id, image_url) VALUES ($1, $2, $3) RETURNING id, content, created_at, image_url',
            [content || '', userId, imageUrl]
        );

        // 作成した投稿をレスポンスに返す
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('投稿作成エラー:', error);
        res.status(500).json({ error: '投稿の作成に失敗しました' });
    }
});

app.delete('/api/v1/statuses/:id', async (req, res) => {
    const postId = req.params.id;
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }

    try {
        const decoded = jwt.verify(token, secretKey);
        const userId = decoded.id;

        const post = await pool.query('SELECT * FROM posts WHERE id = $1 AND user_id = $2', [postId, userId]);
        if (post.rows.length === 0) {
            return res.status(404).json({ error: '投稿が見つかりません' });
        }

        // 画像ファイルの削除
        const imageUrl = post.rows[0].image_url;
        if (imageUrl) {
            const imagePath = path.join(__dirname, 'uploads', imageUrl);  // 画像が`uploads`ディレクトリに保存されている前提
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);  // 画像ファイルの削除
            }
        }

        // 投稿を削除
        await pool.query('DELETE FROM posts WHERE id = $1 AND user_id = $2', [postId, userId]);
        res.status(200).json({ message: '投稿が削除されました' });
    } catch (error) {
        console.error('投稿削除エラー:', error);
        res.status(500).json({ error: '削除に失敗しました' });
    }
});

// アカウント削除API
app.delete('/api/v1/delete-account', async (req, res) => {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }

    try {
        const decoded = jwt.verify(token, secretKey);
        const userId = decoded.id;

        // ユーザーの投稿を削除
        await pool.query('DELETE FROM posts WHERE user_id = $1', [userId]);

        // ユーザーを削除
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);

        res.status(200).json({ message: 'アカウントが削除されました' });
    } catch (error) {
        console.error('アカウント削除エラー:', error);
        res.status(500).json({ error: 'アカウント削除に失敗しました' });
    }
});


// サーバー起動
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
});
