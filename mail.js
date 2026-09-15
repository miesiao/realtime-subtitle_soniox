// Order-notification email (SPEC step 4). This is the ONLY email this app
// sends — there is no user-facing mail (no receipts, no password resets) —
// so it's kept as one small fire-and-forget helper rather than a general
// mail layer. A send failure must never block an order submission (SPEC:
// "寄信失敗只 log,不中斷下單"), so this never throws — every caller gets a
// resolved Promise no matter what happened.
import nodemailer from 'nodemailer';

const SMTP_CONFIGURED = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (SMTP_CONFIGURED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.error(
    'Missing SMTP_HOST/SMTP_USER/SMTP_PASS — order notification emails are disabled. ' +
    'Orders will still be created and shown to the host; you just won\'t get an email ' +
    'about them, so you\'d have to check the DB by hand. Set these in .env to enable it.'
  );
}

const NOTIFY_TO = process.env.ORDER_NOTIFY_EMAIL || 'hmyculture@gmail.com';

// Called once, right when the host fills in the transfer's last five digits
// (SPEC step 4) — everything a human needs to go match this against the
// bank statement and then run the SPEC-step-5 confirmation SQL by hand.
export async function sendOrderNotificationEmail({ order, user }) {
  if (!transporter) return;
  const subject = `[即時字幕儲值] 訂單 ${order.id} — 待確認`;
  const text = [
    `訂單編號：${order.id}`,
    `使用者：${user.name || '(無名稱)'} <${user.email || '(無 email)'}>`,
    `付款金額：${order.amount_paid} 元`,
    `到帳點數：${order.credits_to_add} 點`,
    `轉帳後五碼：${order.last_five}`,
    `下單時間：${order.created_at}`,
  ].join('\n');
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: NOTIFY_TO,
      subject,
      text,
    });
  } catch (err) {
    console.error(`[mail] failed to send order notification for order ${order.id}:`, err);
  }
}

// Called once, right when the order is first created (POST /api/orders) —
// before the host has necessarily even transferred anything. Distinct from
// sendOrderNotificationEmail above (that one fires on the last-five
// confirmation, i.e. "please go check the bank statement now"); this one is
// just "heads up, a new order exists and is waiting on a transfer". Same
// fire-and-forget contract: a send failure must never affect order creation
// (SPEC: "寄信失敗只 log,不中斷下單"), so this never throws.
export async function sendOrderCreatedEmail({ order, user }) {
  if (!transporter) return;
  const subject = `[即時字幕儲值] 新訂單/等待轉帳 — 訂單 ${order.id}`;
  const text = [
    `訂單編號：${order.id}`,
    `使用者：${user.name || '(無名稱)'} <${user.email || '(無 email)'}>`,
    `應匯金額：${order.amount_paid} 元`,
    `到帳點數：${order.credits_to_add} 點`,
    `下單時間：${order.created_at}`,
  ].join('\n');
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: NOTIFY_TO,
      subject,
      text,
    });
  } catch (err) {
    console.error(`[mail] failed to send order-created notification for order ${order.id}:`, err);
  }
}
