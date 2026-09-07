const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

console.log('🔥 СЕРВЕР ЗАПУСКАЕТСЯ...');

// ===== FIREBASE =====
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
  console.log('✅ FIREBASE ИНИЦИАЛИЗИРОВАН');
} else {
  console.log('⚠️ НЕТ FIREBASE_PRIVATE_KEY');
}

const db = admin.firestore();
const SECRET_KEY = process.env.SECRET_KEY || 'my-super-secret-key-2026';

// ===== ПРОВЕРКА ПОДПИСИ =====
function verifySignature(userId, timestamp, signature) {
  const data = userId + '|' + timestamp;
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
  return signature === expected;
}

// ===== ТЕСТОВЫЕ ЭНДПОИНТЫ =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Сервер работает!' });
});

app.get('/api/checkAdmin', (req, res) => {
  res.json({ isAdmin: false });
});

// ================================================================
// ===================== ОСНОВНЫЕ API =============================
// ================================================================

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

// ================================================================
// ===================== АДМИНСКИЕ API (БЕЗ ПРОВЕРКИ ПОДПИСИ) =====
// ================================================================

// ===== АДМИН: ПОЛУЧИТЬ ВСЕ ЗАЯВКИ =====
app.post('/api/getAdminRequests', async (req, res) => {
  try {
    // ПРОВЕРКА ПОДПИСИ ОТКЛЮЧЕНА ДЛЯ АДМИНКИ
    // const { timestamp, signature } = req.body;
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    
    console.log('📥 Запрос всех заявок от админа');
    
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
    
    console.log(`📊 Найдено заявок: ${requests.length}`);
    res.json({ requests });
  } catch (error) {
    console.error('❌ Ошибка getAdminRequests:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: ПОДТВЕРДИТЬ ЗАЯВКУ =====
app.post('/api/confirmWithdraw', async (req, res) => {
  try {
    const { requestId, comment, timestamp, signature } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    
    const docRef = db.collection('withdraw_requests').doc(requestId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Заявка не найдена' });
    const data = doc.data();
    await docRef.update({
      status: 'confirmed',
      comment: comment || 'Подтверждено администратором',
      confirmedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    try {
      const message = `✅ Ваш вывод на ${data.method} подтверждён!\n💰 Сумма: ${data.amount.toFixed(2)} ₽\n📝 Комментарий: ${comment || 'Подтверждено'}`;
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

// ===== АДМИН: ОТКЛОНИТЬ ЗАЯВКУ =====
app.post('/api/rejectWithdraw', async (req, res) => {
  try {
    const { requestId, timestamp, signature } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    
    const docRef = db.collection('withdraw_requests').doc(requestId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Заявка не найдена' });
    const data = doc.data();
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

// ===== АДМИН: СТАТИСТИКА =====
app.post('/api/getStats', async (req, res) => {
  try {
    // ПРОВЕРКА ПОДПИСИ ОТКЛЮЧЕНА
    // const { timestamp, signature } = req.body;
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    
    console.log('📊 Запрос статистики от админа');
    
    const usersSnapshot = await db.collection('users').get();
    let totalBalance = 0;
    let totalViews = 0;
    let totalUsers = 0;
    
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      totalBalance += data.balance || 0;
      totalViews += (data.adWatchHistory || []).length;
      totalUsers++;
    });
    
    res.json({
      totalUsers: totalUsers,
      totalBalance: totalBalance,
      totalViews: totalViews
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: ПОИСК ПОЛЬЗОВАТЕЛЯ =====
app.post('/api/searchUser', async (req, res) => {
  try {
    const { userId } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    
    const doc = await db.collection('users').doc(userId.toString()).get();
    if (!doc.exists) return res.json({ user: null });
    const data = doc.data();
    res.json({
      user: {
        balance: data.balance || 0,
        completedTasks: data.completedTasks || 0,
        referralsCount: data.referralsCount || 0,
        referralEarnings: data.referralEarnings || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: НАСТРОЙКИ НАГРАД =====
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

app.post('/api/updateRewardSettings', async (req, res) => {
  try {
    const { tabby, adsgram } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    await db.collection('settings').doc('rewardSettings').set({ tabby, adsgram });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: СПИСОК ЗАДАНИЙ =====
app.post('/api/getTasksList', async (req, res) => {
  try {
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    
    const snapshot = await db.collection('user_tasks')
      .where('active', '==', true)
      .get();
    const tasks = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      tasks.push({
        id: doc.id,
        name: data.name,
        link: data.link,
        type: data.type,
        maxUsers: data.maxUsers,
        currentUsers: data.currentUsers || 0
      });
    });
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/deleteTask', async (req, res) => {
  try {
    const { taskId } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    await db.collection('user_tasks').doc(taskId).update({ active: false });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: ПРОМОКОД =====
app.post('/api/createPromo', async (req, res) => {
  try {
    const { reward } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await db.collection('promo_codes').doc(code).set({
      code: code,
      reward: reward,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, code: code });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: РАССЫЛКА =====
app.post('/api/sendMailing', async (req, res) => {
  try {
    const { text } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    const usersSnapshot = await db.collection('users').get();
    let count = 0;
    const promises = [];
    usersSnapshot.forEach(doc => {
      const userId = Number(doc.id);
      promises.push(
        fetch(`https://api.telegram.org/bot8547180586:AAHINmLXuxLaK8hgy6_22DraFPqBh3JQS6A/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: userId,
            text: text,
            parse_mode: 'HTML'
          })
        }).then(() => { count++; }).catch(() => {})
      );
    });
    await Promise.all(promises);
    res.json({ success: true, count: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: СБРОС БАЛАНСОВ =====
app.post('/api/resetBalances', async (req, res) => {
  try {
    // Проверка подписи отключена
    // if (!verifySignature('admin', timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
    const usersSnapshot = await db.collection('users').get();
    const promises = [];
    usersSnapshot.forEach(doc => {
      promises.push(doc.ref.update({ balance: 0, frozenBalance: 0, frozenUntil: null }));
    });
    await Promise.all(promises);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИН: СОЗДАТЬ ЗАДАНИЕ (ПОЛЬЗОВАТЕЛЬ) =====
app.post('/api/createUserTask', async (req, res) => {
  try {
    const { userId, name, link, type, users, totalCost } = req.body;
    // Проверка подписи отключена
    // if (!verifySignature(userId, timestamp, signature)) {
    //   return res.status(403).json({ error: 'Недействительная подпись' });
    // }
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

// ===== ТЕСТОВЫЙ ЭНДПОИНТ (ВСЕ ЗАЯВКИ) =====
app.get('/api/testAllRequests', async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests').get();
    const requests = [];
    snapshot.forEach(doc => {
      requests.push({ id: doc.id, ...doc.data() });
    });
    res.json({ total: requests.length, requests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 СЕРВЕР ЗАПУЩЕН НА ПОРТУ ${PORT}`);
  console.log('✅ ВСЕ АДМИНСКИЕ API ЗАГРУЖЕНЫ (ПРОВЕРКА ПОДПИСИ ОТКЛЮЧЕНА)');
});
