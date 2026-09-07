const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = {
  "type": "service_account",
  "project_id": "fhrbfbgo",
  "private_key_id": "2a280a570099a8c3cc9f4e44d2e20ce8d9d447a2",
  "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  "client_email": "firebase-adminsdk-fbsvc@fhrbfbgo.iam.gserviceaccount.com",
  "client_id": "105129060245967922174",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40fhrbfbgo.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const SECRET_KEY = process.env.SECRET_KEY || 'my-super-secret-key-2026';

function verifySignature(userId, timestamp, signature) {
  const data = userId + '|' + timestamp;
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
  return signature === expected;
}

app.post('/api/getBalance', async (req, res) => {
  try {
    const { userId, timestamp, signature } = req.body;
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    const doc = await db.collection('users').doc(userId.toString()).get();
    if (!doc.exists) return res.json({ balance: 0, frozenBalance: 0 });
    const data = doc.data();
    res.json({
      balance: data.balance || 0,
      frozenBalance: data.frozenBalance || 0,
      frozenUntil: data.frozenUntil || null,
      completedTasks: data.completedTasks || 0,
      referralEarnings: data.referralEarnings || 0,
      referralsCount: data.referralsCount || 0,
      adWatchHistory: data.adWatchHistory || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/updateBalance', async (req, res) => {
  try {
    const { userId, amount, timestamp, signature } = req.body;
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    if (Math.abs(amount) > 10) {
      return res.status(403).json({ error: 'Слишком большая сумма' });
    }
    await db.collection('users').doc(userId.toString()).update({
      balance: admin.firestore.FieldValue.increment(amount)
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/addAdView', async (req, res) => {
  try {
    const { userId, timestamp, signature } = req.body;
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    const docRef = db.collection('users').doc(userId.toString());
    const doc = await docRef.get();
    const data = doc.data() || {};
    const adsWatched = (data.adsWatchedForReferral || 0) + 1;
    const adWatchHistory = data.adWatchHistory || [];
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const recentViews = adWatchHistory.filter(t => t > oneHourAgo);
    recentViews.push(now);
    await docRef.update({
      adWatchHistory: recentViews,
      lastAdWatch: now,
      adsWatchedForReferral: adsWatched
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/createWithdraw', async (req, res) => {
  try {
    const { userId, method, amount, details, timestamp, signature } = req.body;
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    const doc = await db.collection('users').doc(userId.toString()).get();
    const data = doc.data() || {};
    const balance = data.balance || 0;
    if (amount > balance) {
      return res.status(400).json({ error: 'Недостаточно средств' });
    }
    await doc.ref.update({
      balance: admin.firestore.FieldValue.increment(-amount)
    });
    const requestId = userId + '_' + Date.now();
    await db.collection('withdraw_requests').doc(requestId).set({
      userId: Number(userId),
      method: method,
      amount: amount,
      details: details,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, requestId: requestId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/getWithdrawRequests', async (req, res) => {
  try {
    const { userId, timestamp, signature } = req.body;
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    const snapshot = await db.collection('withdraw_requests')
      .where('userId', '==', Number(userId))
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      requests.push({
        id: doc.id,
        amount: data.amount,
        method: data.method,
        status: data.status,
        comment: data.comment || null,
        createdAt: data.createdAt
      });
    });
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/checkAdmin', async (req, res) => {
  try {
    const { userId } = req.body;
    const ADMIN_IDS = [6395099576];
    res.json({ isAdmin: ADMIN_IDS.includes(Number(userId)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/confirmWithdraw', async (req, res) => {
  try {
    const { requestId, comment, timestamp, signature } = req.body;
    if (!verifySignature('admin', timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    const docRef = db.collection('withdraw_requests').doc(requestId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Заявка не найдена' });
    const data = doc.data();
    await docRef.update({
      status: 'confirmed',
      comment: comment,
      confirmedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    try {
      const message = `✅ Ваш вывод на ${data.method} подтверждён!\n💰 Сумма: ${data.amount.toFixed(2)} ₽\n📝 Комментарий: ${comment}`;
      await fetch(`https://api.telegram.org/bot8547180586:AAHINmLXuxLaK8hgy6_22DraFPqBh3JQS6A/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(data.userId),
          text: message,
          parse_mode: 'HTML'
        })
      });
    } catch(e) {}
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
