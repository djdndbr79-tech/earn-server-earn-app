const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ===== FIREBASE (только на сервере!) =====
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

// ===== API: ПОЛУЧИТЬ БАЛАНС =====
app.post('/api/getBalance', async (req, res) => {
  try {
    const { userId, timestamp, signature } = req.body;
    
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    
    const doc = await db.collection('users').doc(userId.toString()).get();
    if (!doc.exists) {
      return res.json({ balance: 0, frozenBalance: 0 });
    }
    
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

// ===== API: ОБНОВИТЬ БАЛАНС =====
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

// ===== API: ДОБАВИТЬ ПРОСМОТР =====
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
    
    // Проверяем реферальный бонус
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

// ===== API: СОЗДАТЬ ЗАЯВКУ НА ВЫВОД =====
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

// ===== API: ПОЛУЧИТЬ ЗАЯВКИ =====
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

// ===== API: АДМИН - ПОЛУЧИТЬ ВСЕ ЗАЯВКИ =====
app.post('/api/getAdminRequests', async (req, res) => {
  try {
    const { timestamp, signature } = req.body;
    
    if (!verifySignature('admin', timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    
    const snapshot = await db.collection('withdraw_requests')
      .where('status', 'in', ['pending', 'need_check'])
      .orderBy('createdAt', 'desc')
      .get();
    
    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      requests.push({
        id: doc.id,
        userId: data.userId,
        amount: data.amount,
        method: data.method,
        details: data.details,
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

// ===== API: АДМИН - ПОДТВЕРДИТЬ ЗАЯВКУ =====
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
    
    // Отправляем уведомление пользователю
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

// ===== API: АДМИН - ОТКЛОНИТЬ ЗАЯВКУ =====
app.post('/api/rejectWithdraw', async (req, res) => {
  try {
    const { requestId, timestamp, signature } = req.body;
    
    if (!verifySignature('admin', timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    
    const docRef = db.collection('withdraw_requests').doc(requestId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Заявка не найдена' });
    
    const data = doc.data();
    
    // Возвращаем баланс
    await db.collection('users').doc(data.userId.toString()).update({
      balance: admin.firestore.FieldValue.increment(data.amount)
    });
    
    await docRef.update({
      status: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== API: НАСТРОЙКИ НАГРАД =====
app.post('/api/getRewardSettings', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('rewardSettings').get();
    if (doc.exists) {
      res.json(doc.data());
    } else {
      res.json({ tabby: { min: 0.08, max: 0.10 }, adsgram: { min: 0.01, max: 0.15 } });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== API: СОЗДАТЬ ЗАДАНИЕ =====
app.post('/api/createUserTask', async (req, res) => {
  try {
    const { userId, name, link, type, users, totalCost, timestamp, signature } = req.body;
    
    if (!verifySignature(userId, timestamp, signature)) {
      return res.status(403).json({ error: 'Недействительная подпись' });
    }
    
    const taskId = 'user_task_' + Date.now() + '_' + userId;
    await db.collection('user_tasks').doc(taskId).set({
      id: taskId,
      creatorId: Number(userId),
      name: name,
      link: link,
      type: type,
      isChannel: type === 'channel',
      reward: 0.7,
      pricePerUser: 1.1,
      maxUsers: users,
      currentUsers: 0,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, taskId: taskId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== API: ПРОВЕРКА АДМИНА =====
app.post('/api/checkAdmin', async (req, res) => {
  try {
    const { userId } = req.body;
    const ADMIN_IDS = [6395099576];
    res.json({ isAdmin: ADMIN_IDS.includes(Number(userId)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
