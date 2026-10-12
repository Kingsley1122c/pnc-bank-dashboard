import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Resend } from 'resend';

import { escapeHtml, isValidEmail, isValidEmailHeader, normalizeEmail } from './security.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const CLAIM_TIMEOUT_MS = 10 * 60_000;
const FINAL_PROVIDER_STATUSES = new Set(['delivered', 'bounced', 'complained', 'failed', 'suppressed']);
const EMAIL_LOCALES = {
  en: {
    intl: 'en-US', hello: 'Hello', customer: 'Customer', account: 'Account', status: 'Status', amount: 'Amount', reference: 'Reference', date: 'Date', created: 'Created', ending: 'Ending', open: 'Open Nevora Core', verify: 'Verify email', reset: 'Reset password', reason: 'Reason', help: 'For help, visit', unavailable: 'Not available',
    disclosure: 'Nevora Core is a financial operations platform. Regulated banking services require separately disclosed licensed providers.', privacy: 'This service message was sent individually to protect customer privacy. Never reply with a password, verification code, or full account number.',
    statuses: { completed: 'Completed', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', failed: 'Failed' },
    copy: { welcomeSubject: 'Welcome to Nevora Core', welcomePreheader: 'Your Nevora Core account has been created.', welcomeHeading: 'Your account is ready', welcomeOne: 'Welcome to Nevora Core. Your account was created successfully.', welcomeTwo: 'Sign in to review your account details and complete any outstanding verification steps.', verifySubject: 'Verify your Nevora Core email', verifyPreheader: 'Verify the email address for your Nevora Core profile.', verifyHeading: 'Verify your email', verifyBody: 'Use the secure link below to confirm this email address. The link expires in 24 hours.', resetSubject: 'Reset your Nevora Core password', resetPreheader: 'A password reset was requested.', resetHeading: 'Reset your password', resetOne: 'Use the secure link below to choose a new password. The link expires in 30 minutes.', resetTwo: 'If you did not request this, you can ignore this email.', changedSubject: 'Your Nevora Core password was changed', changedPreheader: 'Your password has been changed.', changedHeading: 'Password changed', changedOne: 'Your Nevora Core password was changed successfully.', changedTwo: 'If you did not make this change, contact support immediately.', loginSubject: 'New sign-in to your Nevora Core account', loginPreheader: 'A successful sign-in was recorded.', loginHeading: 'New sign-in', loginOne: 'A successful sign-in to your Nevora Core account was recorded.', loginTwo: 'If this was not you, reset your password and contact support immediately.', sentCompleted: 'Nevora Core transfer completed', sentPending: 'Nevora Core transfer submitted', receivedCompleted: 'You received a Nevora Core transfer', receivedPending: 'Incoming transfer pending verification', transferUpdate: '{amount} transfer update.', sentCompletedBody: 'Your transfer to {name} completed.', sentPendingBody: 'Your transfer to {name} is pending recipient verification.', receivedCompletedBody: '{name} sent money to your Nevora Core account.', receivedPendingBody: '{name} sent money that remains on hold until account verification is complete.', depositSubject: 'Deposit posted to your Nevora Core account', depositPreheader: '{amount} was credited to your account.', depositHeading: 'Deposit completed', depositBody: 'A deposit was posted to your {account} account.', withdrawalSubject: 'Withdrawal {status}', withdrawalPreheader: '{amount} withdrawal update.' },
    withdrawals: { requested: 'Your withdrawal request was received and is pending review. No payout has been completed.', approved: 'Withdrawal {reference} was approved. Contact support for the secure withdrawal code.', rejected: 'Withdrawal {reference} was rejected. No payout was completed and no funds were debited.', 'code-entered': 'Code received for {reference}. The withdrawal remains pending for compliance review. No payout has been completed.', failed: 'Withdrawal {reference} failed after pending review. No payout was completed and your funds remain available.' },
  },
  ko: {
    intl: 'ko-KR', hello: '안녕하세요', customer: '고객님', account: '계정', status: '상태', amount: '금액', reference: '참조 번호', date: '날짜', created: '생성됨', ending: '끝자리', open: 'Nevora Core 열기', verify: '이메일 인증', reset: '비밀번호 재설정', reason: '사유', help: '도움이 필요하면 다음을 방문하세요', unavailable: '사용할 수 없음',
    disclosure: 'Nevora Core는 금융 운영 플랫폼입니다. 규제 대상 은행 서비스에는 별도로 고지된 인가 제공업체가 필요합니다.', privacy: '고객 개인정보 보호를 위해 개별 발송된 서비스 메시지입니다. 비밀번호, 인증 코드 또는 전체 계좌번호를 회신하지 마세요.', statuses: { completed: '완료', pending: '대기 중', approved: '승인됨', rejected: '거절됨', failed: '실패' },
    copy: { welcomeSubject: 'Nevora Core에 오신 것을 환영합니다', welcomePreheader: 'Nevora Core 계정이 생성되었습니다.', welcomeHeading: '계정이 준비되었습니다', welcomeOne: 'Nevora Core 계정이 성공적으로 생성되었습니다.', welcomeTwo: '로그인하여 계정 정보를 확인하고 남은 인증 단계를 완료하세요.', verifySubject: 'Nevora Core 이메일을 인증하세요', verifyPreheader: 'Nevora Core 프로필의 이메일 주소를 인증하세요.', verifyHeading: '이메일 인증', verifyBody: '아래의 보안 링크로 이메일 주소를 확인하세요. 링크는 24시간 후 만료됩니다.', resetSubject: 'Nevora Core 비밀번호 재설정', resetPreheader: '비밀번호 재설정이 요청되었습니다.', resetHeading: '비밀번호 재설정', resetOne: '아래의 보안 링크에서 새 비밀번호를 설정하세요. 링크는 30분 후 만료됩니다.', resetTwo: '직접 요청하지 않았다면 이 이메일을 무시하세요.', changedSubject: 'Nevora Core 비밀번호가 변경되었습니다', changedPreheader: '비밀번호가 변경되었습니다.', changedHeading: '비밀번호 변경 완료', changedOne: 'Nevora Core 비밀번호가 성공적으로 변경되었습니다.', changedTwo: '직접 변경하지 않았다면 즉시 지원팀에 문의하세요.', loginSubject: 'Nevora Core 계정에 새로 로그인했습니다', loginPreheader: '로그인 성공이 기록되었습니다.', loginHeading: '새 로그인', loginOne: 'Nevora Core 계정의 로그인 성공이 기록되었습니다.', loginTwo: '본인이 아니라면 비밀번호를 재설정하고 즉시 지원팀에 문의하세요.', sentCompleted: 'Nevora Core 송금 완료', sentPending: 'Nevora Core 송금 접수', receivedCompleted: 'Nevora Core 송금을 받았습니다', receivedPending: '수신 송금 인증 대기 중', transferUpdate: '{amount} 송금 상태 안내입니다.', sentCompletedBody: '{name}님에게 보낸 송금이 완료되었습니다.', sentPendingBody: '{name}님에게 보낸 송금이 수취인 인증을 기다리고 있습니다.', receivedCompletedBody: '{name}님이 Nevora Core 계정으로 송금했습니다.', receivedPendingBody: '{name}님이 보낸 금액은 계정 인증이 완료될 때까지 보류됩니다.', depositSubject: 'Nevora Core 계정에 입금되었습니다', depositPreheader: '{amount}이 계정에 입금되었습니다.', depositHeading: '입금 완료', depositBody: '{account} 계정에 입금되었습니다.', withdrawalSubject: '출금 {status}', withdrawalPreheader: '{amount} 출금 상태 안내입니다.' },
    withdrawals: { requested: '출금 요청이 접수되어 검토 대기 중입니다. 지급은 완료되지 않았습니다.', approved: '출금 {reference}이 승인되었습니다. 안전한 출금 코드는 지원팀에 문의하세요.', rejected: '출금 {reference}이 거절되었습니다. 지급 및 자금 인출은 이루어지지 않았습니다.', 'code-entered': '{reference}의 코드가 접수되었습니다. 출금은 규정 준수 검토를 위해 대기 중이며 지급은 완료되지 않았습니다.', failed: '출금 {reference}이 검토 후 실패했습니다. 지급은 이루어지지 않았으며 자금은 계속 사용할 수 있습니다.' },
  },
  ja: {
    intl: 'ja-JP', hello: 'こんにちは', customer: 'お客様', account: 'アカウント', status: 'ステータス', amount: '金額', reference: '参照番号', date: '日時', created: '作成済み', ending: '末尾', open: 'Nevora Coreを開く', verify: 'メールを確認', reset: 'パスワードをリセット', reason: '理由', help: 'サポートについては次をご覧ください', unavailable: '利用できません',
    disclosure: 'Nevora Coreは金融オペレーションプラットフォームです。規制対象の銀行サービスには、別途開示される認可事業者が必要です。', privacy: 'お客様のプライバシー保護のため個別に送信されたサービスメッセージです。パスワード、認証コード、口座番号全桁を返信しないでください。', statuses: { completed: '完了', pending: '保留中', approved: '承認済み', rejected: '却下済み', failed: '失敗' },
    copy: { welcomeSubject: 'Nevora Coreへようこそ', welcomePreheader: 'Nevora Coreアカウントが作成されました。', welcomeHeading: 'アカウントの準備ができました', welcomeOne: 'Nevora Coreアカウントが正常に作成されました。', welcomeTwo: 'サインインしてアカウント情報を確認し、残りの確認手続きを完了してください。', verifySubject: 'Nevora Coreのメールを確認してください', verifyPreheader: 'Nevora Coreプロフィールのメールアドレスを確認してください。', verifyHeading: 'メールアドレスの確認', verifyBody: '以下の安全なリンクでメールアドレスを確認してください。リンクは24時間後に失効します。', resetSubject: 'Nevora Coreのパスワードをリセット', resetPreheader: 'パスワードのリセットが要求されました。', resetHeading: 'パスワードのリセット', resetOne: '以下の安全なリンクで新しいパスワードを設定してください。リンクは30分後に失効します。', resetTwo: 'この操作を要求していない場合は、このメールを無視してください。', changedSubject: 'Nevora Coreのパスワードが変更されました', changedPreheader: 'パスワードが変更されました。', changedHeading: 'パスワード変更完了', changedOne: 'Nevora Coreのパスワードが正常に変更されました。', changedTwo: 'ご自身で変更していない場合は、直ちにサポートへご連絡ください。', loginSubject: 'Nevora Coreアカウントへの新しいサインイン', loginPreheader: 'サインインの成功が記録されました。', loginHeading: '新しいサインイン', loginOne: 'Nevora Coreアカウントへのサインインの成功が記録されました。', loginTwo: 'ご本人でない場合は、パスワードをリセットして直ちにサポートへご連絡ください。', sentCompleted: 'Nevora Core送金完了', sentPending: 'Nevora Core送金受付', receivedCompleted: 'Nevora Core送金を受け取りました', receivedPending: '受取送金の確認待ち', transferUpdate: '{amount}の送金状況です。', sentCompletedBody: '{name}さんへの送金が完了しました。', sentPendingBody: '{name}さんへの送金は受取人の確認待ちです。', receivedCompletedBody: '{name}さんがNevora Coreアカウントへ送金しました。', receivedPendingBody: '{name}さんからの送金はアカウント確認が完了するまで保留されます。', depositSubject: 'Nevora Coreアカウントへ入金されました', depositPreheader: '{amount}がアカウントに入金されました。', depositHeading: '入金完了', depositBody: '{account}アカウントへ入金されました。', withdrawalSubject: '出金{status}', withdrawalPreheader: '{amount}の出金状況です。' },
    withdrawals: { requested: '出金申請を受け付け、審査待ちです。支払いは完了していません。', approved: '出金{reference}が承認されました。安全な出金コードについてはサポートへお問い合わせください。', rejected: '出金{reference}は却下されました。支払いおよび資金の引き落としは行われていません。', 'code-entered': '{reference}のコードを受け付けました。出金はコンプライアンス審査中で、支払いは完了していません。', failed: '出金{reference}は審査後に失敗しました。支払いは行われず、資金は引き続き利用できます。' },
  },
  'zh-CN': {
    intl: 'zh-CN', hello: '您好', customer: '客户', account: '账户', status: '状态', amount: '金额', reference: '参考编号', date: '日期', created: '已创建', ending: '尾号', open: '打开 Nevora Core', verify: '验证邮箱', reset: '重置密码', reason: '原因', help: '如需帮助，请访问', unavailable: '不可用',
    disclosure: 'Nevora Core 是金融运营平台。受监管的银行服务需要另行披露的持牌服务商。', privacy: '此服务消息为保护客户隐私而单独发送。请勿回复密码、验证码或完整账号。', statuses: { completed: '已完成', pending: '待处理', approved: '已批准', rejected: '已拒绝', failed: '失败' },
    copy: { welcomeSubject: '欢迎使用 Nevora Core', welcomePreheader: '您的 Nevora Core 账户已创建。', welcomeHeading: '账户已准备就绪', welcomeOne: '您的 Nevora Core 账户已成功创建。', welcomeTwo: '请登录查看账户详情并完成尚未完成的验证步骤。', verifySubject: '验证您的 Nevora Core 邮箱', verifyPreheader: '请验证 Nevora Core 个人资料中的邮箱地址。', verifyHeading: '验证邮箱', verifyBody: '请使用下方安全链接确认此邮箱地址。链接将在24小时后失效。', resetSubject: '重置 Nevora Core 密码', resetPreheader: '已收到密码重置请求。', resetHeading: '重置密码', resetOne: '请使用下方安全链接设置新密码。链接将在30分钟后失效。', resetTwo: '如果并非您本人请求，请忽略此邮件。', changedSubject: '您的 Nevora Core 密码已更改', changedPreheader: '您的密码已更改。', changedHeading: '密码已更改', changedOne: '您的 Nevora Core 密码已成功更改。', changedTwo: '如果并非您本人操作，请立即联系支持团队。', loginSubject: 'Nevora Core 账户有新的登录', loginPreheader: '已记录一次成功登录。', loginHeading: '新的登录', loginOne: '您的 Nevora Core 账户已记录一次成功登录。', loginTwo: '如果并非您本人，请重置密码并立即联系支持团队。', sentCompleted: 'Nevora Core 转账已完成', sentPending: 'Nevora Core 转账已提交', receivedCompleted: '您收到了一笔 Nevora Core 转账', receivedPending: '收款转账等待验证', transferUpdate: '{amount} 转账状态更新。', sentCompletedBody: '您向{name}的转账已完成。', sentPendingBody: '您向{name}的转账正在等待收款人验证。', receivedCompletedBody: '{name}已向您的 Nevora Core 账户转账。', receivedPendingBody: '{name}发送的款项将在账户验证完成前保持冻结。', depositSubject: '款项已存入您的 Nevora Core 账户', depositPreheader: '{amount}已存入您的账户。', depositHeading: '存款已完成', depositBody: '一笔存款已计入您的{account}账户。', withdrawalSubject: '提现{status}', withdrawalPreheader: '{amount}提现状态更新。' },
    withdrawals: { requested: '您的提现申请已收到，正在等待审核。尚未完成付款。', approved: '提现{reference}已获批准。请联系支持团队获取安全提现码。', rejected: '提现{reference}已被拒绝。未完成付款，也未扣除资金。', 'code-entered': '已收到{reference}的代码。提现仍在等待合规审核，尚未完成付款。', failed: '提现{reference}在审核后失败。未完成付款，您的资金仍可使用。' },
  },
  'zh-TW': {
    intl: 'zh-TW', hello: '您好', customer: '客戶', account: '帳戶', status: '狀態', amount: '金額', reference: '參考編號', date: '日期', created: '已建立', ending: '末碼', open: '開啟 Nevora Core', verify: '驗證電子郵件', reset: '重設密碼', reason: '原因', help: '如需協助，請造訪', unavailable: '無法使用',
    disclosure: 'Nevora Core 是金融營運平台。受監管的銀行服務需要另行揭露的持牌服務商。', privacy: '此服務訊息為保護客戶隱私而單獨傳送。請勿回覆密碼、驗證碼或完整帳號。', statuses: { completed: '已完成', pending: '待處理', approved: '已核准', rejected: '已拒絕', failed: '失敗' },
    copy: { welcomeSubject: '歡迎使用 Nevora Core', welcomePreheader: '您的 Nevora Core 帳戶已建立。', welcomeHeading: '帳戶已準備就緒', welcomeOne: '您的 Nevora Core 帳戶已成功建立。', welcomeTwo: '請登入查看帳戶詳情並完成尚未完成的驗證步驟。', verifySubject: '驗證您的 Nevora Core 電子郵件', verifyPreheader: '請驗證 Nevora Core 個人資料中的電子郵件地址。', verifyHeading: '驗證電子郵件', verifyBody: '請使用下方安全連結確認此電子郵件地址。連結將於24小時後失效。', resetSubject: '重設 Nevora Core 密碼', resetPreheader: '已收到密碼重設要求。', resetHeading: '重設密碼', resetOne: '請使用下方安全連結設定新密碼。連結將於30分鐘後失效。', resetTwo: '如果並非您本人要求，請忽略此郵件。', changedSubject: '您的 Nevora Core 密碼已變更', changedPreheader: '您的密碼已變更。', changedHeading: '密碼已變更', changedOne: '您的 Nevora Core 密碼已成功變更。', changedTwo: '如果並非您本人操作，請立即聯絡支援團隊。', loginSubject: 'Nevora Core 帳戶有新的登入', loginPreheader: '已記錄一次成功登入。', loginHeading: '新的登入', loginOne: '您的 Nevora Core 帳戶已記錄一次成功登入。', loginTwo: '如果並非您本人，請重設密碼並立即聯絡支援團隊。', sentCompleted: 'Nevora Core 轉帳已完成', sentPending: 'Nevora Core 轉帳已提交', receivedCompleted: '您收到了一筆 Nevora Core 轉帳', receivedPending: '收款轉帳等待驗證', transferUpdate: '{amount} 轉帳狀態更新。', sentCompletedBody: '您向{name}的轉帳已完成。', sentPendingBody: '您向{name}的轉帳正在等待收款人驗證。', receivedCompletedBody: '{name}已向您的 Nevora Core 帳戶轉帳。', receivedPendingBody: '{name}傳送的款項將在帳戶驗證完成前維持凍結。', depositSubject: '款項已存入您的 Nevora Core 帳戶', depositPreheader: '{amount}已存入您的帳戶。', depositHeading: '存款已完成', depositBody: '一筆存款已計入您的{account}帳戶。', withdrawalSubject: '提領{status}', withdrawalPreheader: '{amount}提領狀態更新。' },
    withdrawals: { requested: '您的提領申請已收到，正在等待審核。尚未完成付款。', approved: '提領{reference}已獲核准。請聯絡支援團隊取得安全提領碼。', rejected: '提領{reference}已被拒絕。未完成付款，也未扣除資金。', 'code-entered': '已收到{reference}的代碼。提領仍在等待合規審核，尚未完成付款。', failed: '提領{reference}在審核後失敗。未完成付款，您的資金仍可使用。' },
  },
};

function emailLocale(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'ko') return ['ko', EMAIL_LOCALES.ko];
  if (normalized === 'ja') return ['ja', EMAIL_LOCALES.ja];
  if (['zh-cn', 'zh-hans', 'zh'].includes(normalized)) return ['zh-CN', EMAIL_LOCALES['zh-CN']];
  if (['zh-tw', 'zh-hant'].includes(normalized)) return ['zh-TW', EMAIL_LOCALES['zh-TW']];
  return ['en', EMAIL_LOCALES.en];
}

function asText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function localizedText(template, replacements = {}) {
  return Object.entries(replacements).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

function localizedStatus(words, status) {
  return words.statuses[String(status ?? '').trim().toLowerCase()] || asText(status, 80);
}

function money(amount, currency = 'USD', locale = 'en-US') {
  const numericAmount = Number(amount);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number.isFinite(numericAmount) ? numericAmount : 0);
}

function dateTime(value, locale = 'en-US') {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
    : null;
}

function brandLayout({ preheader, heading, name, paragraphs, details = [], action = null, appBaseUrl, localeCode = 'en', words = EMAIL_LOCALES.en }) {
  const safePreheader = escapeHtml(preheader);
  const safeHeading = escapeHtml(heading);
  const safeName = escapeHtml(name || words.customer);
  const detailsHtml = details.length > 0
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;border-collapse:collapse;background:#f4f7fa;border-radius:8px">${details.map(([label, value]) => `<tr><td style="padding:10px 14px;color:#52606d;font-size:13px;border-bottom:1px solid #dde4ea">${escapeHtml(label)}</td><td style="padding:10px 14px;color:#102a43;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #dde4ea">${escapeHtml(value)}</td></tr>`).join('')}</table>`
    : '';
  const actionHtml = action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#f58025;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${escapeHtml(action.label)}</a></p>`
    : '';
  const text = [heading, '', `${words.hello} ${name || words.customer},`, '', ...paragraphs, '', ...details.map(([label, value]) => `${label}: ${value}`), action ? `${action.label}: ${action.url}` : '', '', `${words.help} ${appBaseUrl}.`, '', words.disclosure, '', words.privacy, '', 'Nevora Core'].filter(Boolean).join('\n');
  const html = `<!doctype html><html lang="${localeCode}"><body style="margin:0;background:#eef2f6;color:#102a43;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${safePreheader}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:8px;overflow:hidden"><tr><td style="background:#073b4c;padding:20px 28px;color:#fff"><span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;border-radius:6px;background:#16a085;font-weight:800;margin-right:10px">NC</span><strong style="font-size:20px;vertical-align:middle">NEVORA CORE</strong></td></tr><tr><td style="padding:30px 28px"><h1 style="font-size:26px;line-height:1.25;margin:0 0 18px">${safeHeading}</h1><p style="font-size:16px;line-height:1.6">${escapeHtml(words.hello)} ${safeName},</p>${paragraphs.map((paragraph) => `<p style="font-size:16px;line-height:1.6">${escapeHtml(paragraph)}</p>`).join('')}${detailsHtml}${actionHtml}<p style="font-size:14px;line-height:1.6;color:#52606d">${escapeHtml(words.help)} <a href="${escapeHtml(appBaseUrl)}" style="color:#005ea8">${escapeHtml(appBaseUrl)}</a>.</p></td></tr><tr><td style="background:#f4f7fa;padding:18px 28px;color:#627d98;font-size:12px;line-height:1.5"><strong>${escapeHtml(words.disclosure)}</strong><br><br>${escapeHtml(words.privacy)}</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

export function renderEmail(templateId, payload, options = {}) {
  const appBaseUrl = options.appBaseUrl || 'http://localhost:5173';
  const [localeCode, words] = emailLocale(payload.locale);
  const layoutOptions = { appBaseUrl, localeCode, words };
  const name = asText(payload.name, 120);
  const reference = asText(payload.reference || payload.transactionId || payload.withdrawalId, 160);
  const occurredAt = dateTime(payload.occurredAt || payload.createdAt || new Date().toISOString(), words.intl) || words.unavailable;
  const amount = money(payload.amount, payload.currency || 'USD', words.intl);
  let subject;
  let content;

  switch (templateId) {
    case 'welcome':
      subject = words.copy.welcomeSubject;
      content = brandLayout({ preheader: words.copy.welcomePreheader, heading: words.copy.welcomeHeading, name, paragraphs: [words.copy.welcomeOne, words.copy.welcomeTwo], details: [[words.account, `${words.ending} ${asText(payload.accountLast4, 4)}`], [words.status, words.created]], action: { label: words.open, url: appBaseUrl }, ...layoutOptions });
      break;
    case 'email-verification':
      subject = words.copy.verifySubject;
      content = brandLayout({ preheader: words.copy.verifyPreheader, heading: words.copy.verifyHeading, name, paragraphs: [words.copy.verifyBody], action: { label: words.verify, url: payload.actionUrl }, ...layoutOptions });
      break;
    case 'password-reset':
      subject = words.copy.resetSubject;
      content = brandLayout({ preheader: words.copy.resetPreheader, heading: words.copy.resetHeading, name, paragraphs: [words.copy.resetOne, words.copy.resetTwo], action: { label: words.reset, url: payload.actionUrl }, ...layoutOptions });
      break;
    case 'password-changed':
      subject = words.copy.changedSubject;
      content = brandLayout({ preheader: words.copy.changedPreheader, heading: words.copy.changedHeading, name, paragraphs: [words.copy.changedOne, words.copy.changedTwo], details: [[words.date, occurredAt]], action: { label: words.open, url: appBaseUrl }, ...layoutOptions });
      break;
    case 'login-alert':
      subject = words.copy.loginSubject;
      content = brandLayout({ preheader: words.copy.loginPreheader, heading: words.copy.loginHeading, name, paragraphs: [words.copy.loginOne, words.copy.loginTwo], details: [[words.date, occurredAt]], action: { label: words.open, url: appBaseUrl }, ...layoutOptions });
      break;
    case 'transfer-sent':
      subject = payload.status === 'Completed' ? words.copy.sentCompleted : words.copy.sentPending;
      content = brandLayout({ preheader: localizedText(words.copy.transferUpdate, { amount }), heading: subject, name, paragraphs: [localizedText(payload.status === 'Completed' ? words.copy.sentCompletedBody : words.copy.sentPendingBody, { name: asText(payload.recipientName, 120) })], details: [[words.amount, amount], [words.reference, reference], [words.date, occurredAt], [words.status, localizedStatus(words, payload.status)]], ...layoutOptions });
      break;
    case 'transfer-received':
      subject = payload.status === 'Completed' ? words.copy.receivedCompleted : words.copy.receivedPending;
      content = brandLayout({ preheader: localizedText(words.copy.transferUpdate, { amount }), heading: subject, name, paragraphs: [localizedText(payload.status === 'Completed' ? words.copy.receivedCompletedBody : words.copy.receivedPendingBody, { name: asText(payload.senderName, 120) })], details: [[words.amount, amount], [words.reference, reference], [words.date, occurredAt], [words.status, localizedStatus(words, payload.status)]], ...layoutOptions });
      break;
    case 'admin-credit':
      subject = words.copy.depositSubject;
      content = brandLayout({ preheader: localizedText(words.copy.depositPreheader, { amount }), heading: words.copy.depositHeading, name, paragraphs: [localizedText(words.copy.depositBody, { account: asText(payload.accountLabel, 80) })], details: [[words.amount, amount], [words.reference, reference], [words.date, occurredAt], [words.status, words.statuses.completed]], ...layoutOptions });
      break;
    case 'withdrawal':
      subject = localizedText(words.copy.withdrawalSubject, { status: localizedStatus(words, payload.status) });
      content = brandLayout({ preheader: localizedText(words.copy.withdrawalPreheader, { amount }), heading: subject, name, paragraphs: [`${localizedText(words.withdrawals[payload.eventKey] || asText(payload.message, 500), { reference })}${payload.reason ? ` ${words.reason}: ${asText(payload.reason, 500)}` : ''}`], details: [[words.amount, amount], [words.reference, reference], [words.date, occurredAt], [words.status, localizedStatus(words, payload.status)]], ...layoutOptions });
      break;
    case 'account-status':
      subject = asText(payload.subject, 160) || 'Important Nevora Core account update';
      content = brandLayout({ preheader: subject, heading: subject, name, paragraphs: [asText(payload.message, 2000)], details: payload.reference ? [[words.reference, reference], [words.date, occurredAt]] : [[words.date, occurredAt]], action: { label: words.open, url: appBaseUrl }, ...layoutOptions });
      break;
    case 'announcement':
      subject = asText(payload.subject, 160);
      content = brandLayout({ preheader: subject, heading: subject, name, paragraphs: [asText(payload.message, 5000)], action: { label: words.open, url: appBaseUrl }, ...layoutOptions });
      break;
    default:
      throw new Error(`Unknown email template: ${templateId}`);
  }

  if (!isValidEmailHeader(subject)) throw new Error('Email subject is invalid.');
  return { subject, ...content };
}

export function enqueueEmail(db, { idempotencyKey, eventType, aggregateType = null, aggregateId = null, recipient, recipientUserId = null, templateId, payload, createdAt = new Date().toISOString() }) {
  const normalizedRecipient = normalizeEmail(recipient);
  if (!isValidEmail(normalizedRecipient)) throw new Error('Email recipient is invalid.');
  let locale = asText(payload?.locale, 20) || 'en';
  if (recipientUserId && !payload?.locale) {
    const user = db.prepare('SELECT raw_json FROM users WHERE id = ?').get(recipientUserId);
    try {
      locale = asText(JSON.parse(user?.raw_json || '{}').locale, 20) || 'en';
    } catch {
      locale = 'en';
    }
  }
  const localizedPayload = { ...payload, locale };
  const result = db.prepare(`
    INSERT INTO email_outbox (
      idempotency_key, event_type, aggregate_type, aggregate_id, recipient, recipient_user_id,
      template_id, payload_json, status, provider_status, created_at, updated_at, next_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(idempotencyKey, eventType, aggregateType, aggregateId, normalizedRecipient, recipientUserId, templateId, JSON.stringify(localizedPayload), createdAt, createdAt, createdAt);
  return result.changes === 1;
}

export function resolveResendSender(env = process.env) {
  const configuredFrom = String(env.EMAIL_FROM ?? '').trim();
  const mailboxMatch = configuredFrom.match(/^([^<>\r\n]+?)\s*<([^<>\s]+)>$/);
  const email = normalizeEmail(mailboxMatch?.[2] ?? configuredFrom);
  const name = String(mailboxMatch?.[1] ?? env.EMAIL_FROM_NAME ?? 'Nevora Core').trim();
  if (!isValidEmail(email) || !name || !isValidEmailHeader(name)) return null;
  return `${name} <${email}>`;
}

export function createResendProvider(env = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const sender = resolveResendSender(env);
  if (!apiKey || !sender) return null;
  const resend = new Resend(apiKey);
  return {
    async send(message, idempotencyKey) {
      const response = await resend.emails.send({ from: sender, ...message }, { idempotencyKey });
      if (response.error) {
        const error = new Error(response.error.message || 'Resend rejected the email.');
        error.name = response.error.name || 'ResendError';
        throw error;
      }
      return { id: response.data?.id };
    },
    verifyWebhook(payload, headers, webhookSecret) {
      return resend.webhooks.verify({ payload, headers, webhookSecret });
    },
  };
}

export function createEmailProcessor({ db, env = process.env, provider = createResendProvider(env), now = () => Date.now() }) {
  const requestedMode = ['disabled', 'restricted', 'live'].includes(String(env.EMAIL_MODE).toLowerCase()) ? String(env.EMAIL_MODE).toLowerCase() : 'disabled';
  const sendAfter = String(env.EMAIL_SEND_AFTER ?? '').trim();
  const sendAfterTime = Date.parse(sendAfter);
  const mode = requestedMode === 'live' && env.NODE_ENV === 'production' && !Number.isFinite(sendAfterTime) ? 'disabled' : requestedMode;
  const testRecipient = normalizeEmail(env.EMAIL_TEST_RECIPIENT);
  const appBaseUrl = String(env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

  async function processOne(row) {
    const claimedAt = new Date(now()).toISOString();
    const claim = db.prepare(`UPDATE email_outbox SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')`).run(claimedAt, row.id);
    if (claim.changes !== 1) return false;
    if (mode === 'restricted' && (!testRecipient || row.recipient !== testRecipient)) {
      db.prepare("UPDATE email_outbox SET status = 'suppressed', provider_status = 'suppressed', last_error = 'Restricted recipient', updated_at = ? WHERE id = ?").run(claimedAt, row.id);
      return true;
    }
    try {
      const rendered = renderEmail(row.template_id, JSON.parse(row.payload_json), { appBaseUrl });
      const response = await provider.send({ to: row.recipient, ...rendered }, row.idempotency_key);
      const acceptedAt = new Date(now()).toISOString();
      db.prepare(`UPDATE email_outbox SET status = 'accepted', provider_status = 'accepted', provider_message_id = ?, last_error = NULL, sent_at = ?, updated_at = ?, next_attempt_at = NULL WHERE id = ?`).run(response.id || null, acceptedAt, acceptedAt, row.id);
    } catch (error) {
      const attemptCount = row.attempt_count + 1;
      const failedAt = new Date(now()).toISOString();
      const nextAttemptAt = attemptCount < MAX_ATTEMPTS ? new Date(now() + RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)]).toISOString() : null;
      db.prepare(`UPDATE email_outbox SET status = 'failed', provider_status = 'failed', last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?`).run(asText(error?.message || 'Email provider unavailable.', 500), failedAt, nextAttemptAt, row.id);
    }
    return true;
  }

  async function processBatch(limit = 20) {
    if (!provider || mode === 'disabled') return { processed: 0, configured: Boolean(provider), mode };
    const currentTime = new Date(now()).toISOString();
    if (Number.isFinite(sendAfterTime)) {
      db.prepare(`
        UPDATE email_outbox
        SET status = 'suppressed', provider_status = 'suppressed', last_error = 'Queued before email activation', updated_at = ?, next_attempt_at = NULL
        WHERE status IN ('pending', 'failed') AND created_at < ?
      `).run(currentTime, new Date(sendAfterTime).toISOString());
    }
    const staleBefore = new Date(now() - CLAIM_TIMEOUT_MS).toISOString();
    db.prepare(`
      UPDATE email_outbox
      SET status = 'failed', provider_status = 'queued', last_error = 'Recovered stale processing claim',
        updated_at = ?, next_attempt_at = ?
      WHERE status = 'processing' AND updated_at <= ? AND attempt_count < ?
    `).run(currentTime, currentTime, staleBefore, MAX_ATTEMPTS);
    const rows = db.prepare(`SELECT * FROM email_outbox WHERE status = 'pending' OR (status = 'failed' AND attempt_count < ? AND next_attempt_at <= ?) ORDER BY created_at, id LIMIT ?`).all(MAX_ATTEMPTS, currentTime, Math.max(1, Math.min(Number(limit) || 20, 100)));
    let processed = 0;
    for (const row of rows) if (await processOne(row)) processed += 1;
    return { processed, configured: true, mode };
  }

  return { processBatch, mode, configured: Boolean(provider) };
}

export function recordResendWebhook(db, event) {
  const eventId = asText(event?.id, 200);
  const eventType = asText(event?.type, 100);
  const providerMessageId = asText(event?.data?.email_id || event?.data?.id, 200);
  if (!eventId || !eventType || !providerMessageId) throw new Error('Webhook event is incomplete.');
  const receivedAt = new Date().toISOString();
  const inserted = db.prepare(`INSERT INTO email_webhook_events (provider_event_id, event_type, provider_message_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider_event_id) DO NOTHING`).run(eventId, eventType, providerMessageId, receivedAt);
  if (inserted.changes === 0) return { duplicate: true };
  const providerStatus = eventType.replace(/^email\./, '');
  const status = providerStatus === 'delivered' ? 'delivered' : ['bounced', 'failed'].includes(providerStatus) ? 'failed' : providerStatus === 'complained' ? 'suppressed' : 'accepted';
  const deliveredAt = providerStatus === 'delivered' ? receivedAt : null;
  db.prepare(`UPDATE email_outbox SET status = ?, provider_status = ?, delivered_at = COALESCE(?, delivered_at), last_error = CASE WHEN ? IN ('bounced', 'complained', 'failed') THEN ? ELSE last_error END, updated_at = ? WHERE provider_message_id = ?`).run(status, providerStatus, deliveredAt, providerStatus, providerStatus, receivedAt, providerMessageId);
  return { duplicate: false, status: FINAL_PROVIDER_STATUSES.has(providerStatus) ? providerStatus : 'accepted' };
}

export function issueActionToken(db, { userId, purpose, lifetimeMs, now = () => Date.now() }) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const id = randomUUID();
  const createdAt = new Date(now()).toISOString();
  const expiresAt = new Date(now() + lifetimeMs).toISOString();
  db.prepare(`UPDATE auth_action_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`).run(createdAt, userId, purpose);
  db.prepare(`INSERT INTO auth_action_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, purpose, tokenHash, expiresAt, createdAt);
  return { id, token, expiresAt };
}

export function consumeActionToken(db, { token, purpose, now = () => Date.now() }) {
  const tokenHash = createHash('sha256').update(String(token || '')).digest('hex');
  const currentTime = new Date(now()).toISOString();
  const row = db.prepare(`SELECT * FROM auth_action_tokens WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`).get(tokenHash, purpose, currentTime);
  if (!row) return null;
  const result = db.prepare(`UPDATE auth_action_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(currentTime, row.id);
  return result.changes === 1 ? row : null;
}
