require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use(cors());

// قراءة الإعدادات من .env
const PORT = process.env.PORT || 3000;
// لا تضع مفتاح الـ API هنا، ضعه في متغيرات البيئة على Render
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
// افتراضي SENDER_EMAIL تم تعيينه للإيميل الذي ذكرته، لكن الأفضل وضعه كمُتغيّر بيئة على Render
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'homs121homs121@gmail.com';
const SENDER_NAME = process.env.SENDER_NAME || 'موقع شحن الألعاب';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CODE_TTL_MS = parseInt(process.env.CODE_TTL_MS || String(5 * 60 * 1000), 10); // 5 دقائق افتراضياً
const EMAIL_SEND_COOLDOWN_MS = parseInt(process.env.EMAIL_SEND_COOLDOWN_MS || String(60 * 1000), 10); // 60s

if(!BREVO_API_KEY){
  console.warn('⚠️ BREVO_API_KEY غير موجود. الخادم لن يرسل إيميلات فعلياً.');
}
if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
  console.warn('⚠️ معطيات تليجرام ناقصة. إشعارات التليجرام قد لا تعمل.');
}

// تخزين مؤقت للأكواد (in-memory). للإنتاج استعمل Redis أو DB.
const codes = new Map(); // email -> { code, expiresAt }
const lastSentAt = new Map(); // email -> timestamp

// rate limit عام لكل IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 دقيقة
  max: 60, // 60 طلب لكل IP لكل دقيقة
  handler: (req, res) => res.status(429).json({ ok:false, error: 'too_many_requests' })
});
app.use(apiLimiter);

function generateCode(){
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidEmail(email){
  return typeof email === 'string' && /\S+@\S+\.\S+/.test(email);
}

async function sendBrevoEmail(toEmail, code){
  if(!BREVO_API_KEY) return { ok:false, error:'brevo_key_missing' };

  const payload = {
    sender: { email: SENDER_EMAIL, name: SENDER_NAME },
    to: [{ email: toEmail }],
    subject: "كود تسجيل الدخول - موقع شحن الألعاب",
    htmlContent: `<p>كود تسجيل الدخول الخاص بك هو: <strong>${code}</strong></p><p>صالح لمدة ${Math.round(CODE_TTL_MS/60000)} دقيقة.</p>`
  };

  try{
    const res = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY
      },
      timeout: 10000
    });
    return { ok: true, data: res.data };
  }catch(err){
    const detail = err?.response?.data || err?.message || 'request_failed';
    return { ok:false, error: detail };
  }
}

// تنظيف دوري للكودات منتهية الصلاحية
setInterval(()=>{
  const now = Date.now();
  for(const [email, entry] of codes.entries()){
    if(!entry || !entry.expiresAt) { codes.delete(email); continue; }
    if(entry.expiresAt <= now) codes.delete(email);
  }
}, 60 * 1000);

// Endpoint: إرسال كود
app.post('/send-code', async (req, res) => {
  try{
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if(!email) return res.status(400).json({ ok:false, error: 'email_required' });
    if(!isValidEmail(email)) return res.status(400).json({ ok:false, error: 'invalid_email' });

    const last = lastSentAt.get(email) || 0;
    if(Date.now() - last < EMAIL_SEND_COOLDOWN_MS){
      return res.status(429).json({ ok:false, error: 'cooldown_active' });
    }

    const code = generateCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    codes.set(email, { code, expiresAt });
    lastSentAt.set(email, Date.now());

    const sendResult = await sendBrevoEmail(email, code);
    if(!sendResult.ok){
      console.warn('Brevo send failed:', sendResult.error);
      // نحذف الكود لأن الإرسال فشل
      codes.delete(email);
      return res.status(502).json({ ok:false, error: 'brevo_send_failed', detail: sendResult.error });
    }

    return res.json({ ok:true, message: 'sent' });
  }catch(e){
    console.error('send-code error', e);
    return res.status(500).json({ ok:false, error: 'internal_error' });
  }
});

// Endpoint: تحقق الكود
app.post('/verify-code', async (req, res) => {
  try{
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').trim();
    const personalNumber = req.body && req.body.personalNumber;

    if(!email || !code) return res.status(400).json({ ok:false, error: 'missing_params' });

    const entry = codes.get(email);
    if(!entry) return res.status(400).json({ ok:false, error: 'no_code_sent' });

    if(Date.now() > entry.expiresAt){
      codes.delete(email);
      return res.status(400).json({ ok:false, error: 'expired' });
    }

    if(code !== entry.code){
      return res.status(400).json({ ok:false, error: 'wrong_code' });
    }

    // نجاح التحقق: نحذف الكود
    codes.delete(email);

    // ارسال اشعار لتليجرام (اختياري)
    if(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID){
      const text = `تسجيل دخول ناجح:\nالبريد: ${email}\nالرقم الشخصي: ${personalNumber || 'غير مقدم'}\nالوقت: ${new Date().toLocaleString()}`;
      axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text
      }).catch(e => console.warn('tg notify failed', e?.message || e));
    }

    return res.json({ ok:true });
  }catch(e){
    console.error('verify-code error', e);
    return res.status(500).json({ ok:false, error: 'internal_error' });
  }
});

// Endpoint مفيد للواجهة: يعيد إعدادات التبريد ومدة صلاحية الكود
app.get('/config', (_req, res) => {
  res.json({
    ok: true,
    CODE_TTL_MS,
    EMAIL_SEND_COOLDOWN_MS
  });
});

app.get('/', (_req, res) => res.send('Auth server is running'));

app.listen(PORT, () => console.log(`Auth server running on port ${PORT}`));
