const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

console.log('🔥 Базовый сервер запускается....');

const serviceAccount = {
  "type": "service_account",
  "project_id": "fhrbfbgo",
  "private_key_id": "2a280a570099a8c3cc9f4e44d2e20ce8d9d447a2",
  "private_key": process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : null,
  "client_email": "firebase-adminsdk-fbsvc@fhrbfbgo.iam.gserviceaccount.com",
  "client_id": "105129060245967922174",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40fhrbfbgo.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

if (serviceAccount.private_key) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('✅ Firebase инициализирован');
} else {
  console.log('⚠️ Нет FIREBASE_PRIVATE_KEY');
}

const db = admin.firestore();
const SECRET_KEY = process.env.SECRET_KEY || 'my-super-secret-key-2026';

function verifySignature(userId, timestamp, signature) {
  const data = userId + '|' + timestamp;
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
  return signature === expected;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Базовый сервер работает!' });
});

app.get('/api/checkAdmin', (req, res) => {
  res.json({ isAdmin: false });
});

app.post('/api/getBalance', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.json({ balance: 0, frozenBalance: 0 });
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
      adWatchHistory: data.adWatchHistory || [],
      adsWatchedForReferral: data.adsWatchedForReferral || 0,
      referralBonusPaid: data.referralBonusPaid || false,
      lastAdWatch: data.lastAdWatch || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/updateBalance', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId) return res.status(400).json({ error: 'Нет userId' });
    if (Math.abs(amount) > 10) return res.status(403).json({ error: 'Слишком большая сумма' });
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
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Нет userId' });
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
    if (adsWatched >= 4 && data.referrerId && !data.referralBonusPaid) {
      await docRef.update({
        balance: admin.firestore.FieldValue.increment(1.0),
        referralBonusPaid: true,
        referralEarnings: admin.firestore.FieldValue.increment(1.0)
      });
      const refDoc = await db.collection('users').doc(data.referrerId).get();
      if (refDoc.exists) {
        await db.collection('users').doc(data.referrerId).update({
          balance: admin.firestore.FieldValue.increment(4.0),
          referralEarnings: admin.firestore.FieldValue.increment(4.0)
        });
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/createWithdraw', async (req, res) => {
  try {
    const { userId, method, amount, details } = req.body;
    if (!userId) return res.status(400).json({ error: 'Нет userId' });
    const doc = await db.collection('users').doc(userId.toString()).get();
    const data = doc.data() || {};
    const balance = data.balance || 0;
    if (amount > balance) return res.status(400).json({ error: 'Недостаточно средств' });
    await doc.ref.update({ balance: admin.firestore.FieldValue.increment(-amount) });
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
    const { userId } = req.body;
    if (!userId) return res.json({ requests: [] });
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
        comment: data.comment || null
      });
    });
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Базовый сервер запущен на порту ${PORT}`);
});
