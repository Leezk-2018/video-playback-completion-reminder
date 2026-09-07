import crypto from "node:crypto";
import http from "node:http";
import tls from "node:tls";

const HOST = "127.0.0.1";
const PORT = Number(process.env.QQ_MAIL_BRIDGE_PORT || 8787);
const SMTP_HOST = "smtp.qq.com";
const SMTP_PORT = 465;
const MAX_BODY_SIZE = 16 * 1024;

const sender = process.env.QQ_MAIL_FROM?.trim();
const authorizationCode = process.env.QQ_MAIL_AUTH_CODE?.trim();
const bridgeToken = process.env.QQ_MAIL_BRIDGE_TOKEN?.trim();

if (!sender || !authorizationCode || !bridgeToken) {
  console.error(
    "缺少 QQ_MAIL_FROM、QQ_MAIL_AUTH_CODE 或 QQ_MAIL_BRIDGE_TOKEN 环境变量。"
  );
  process.exit(1);
}

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function formatMessage({ to, subject, text }) {
  const messageId = `<${crypto.randomUUID()}@video-playback-reminder.local>`;
  const encodedSubject = `=?UTF-8?B?${encodeBase64(sanitizeHeader(subject))}?=`;
  const body = String(text).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

  return [
    `From: <${sender}>`,
    `To: <${to}>`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    ""
  ].join("\r\n");
}

function connectSmtp() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    socket.setEncoding("utf8");
    socket.setTimeout(20_000, () => {
      socket.destroy(new Error("连接 QQ SMTP 服务器超时。"));
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function createSmtpReader(socket) {
  let buffer = "";
  const responses = [];
  const waiters = [];

  function flush() {
    while (waiters.length && responses.length) {
      waiters.shift()(responses.shift());
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (/^\d{3} /.test(line)) {
        responses.push(line);
      }
    }
    flush();
  });

  return function readResponse() {
    if (responses.length) {
      return Promise.resolve(responses.shift());
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
}

function assertSmtpCode(response, expectedCode) {
  if (!response?.startsWith(String(expectedCode))) {
    throw new Error(`QQ SMTP 服务器拒绝了请求：${response || "无响应"}`);
  }
}

async function sendSmtpCommand(socket, readResponse, command, expectedCode) {
  socket.write(`${command}\r\n`);
  const response = await readResponse();
  assertSmtpCode(response, expectedCode);
}

async function sendQqMail(message) {
  const socket = await connectSmtp();
  const readResponse = createSmtpReader(socket);

  try {
    assertSmtpCode(await readResponse(), 220);
    await sendSmtpCommand(socket, readResponse, "EHLO localhost", 250);
    await sendSmtpCommand(socket, readResponse, "AUTH LOGIN", 334);
    await sendSmtpCommand(socket, readResponse, encodeBase64(sender), 334);
    await sendSmtpCommand(socket, readResponse, encodeBase64(authorizationCode), 235);
    await sendSmtpCommand(socket, readResponse, `MAIL FROM:<${sender}>`, 250);
    await sendSmtpCommand(socket, readResponse, `RCPT TO:<${message.to}>`, 250);
    await sendSmtpCommand(socket, readResponse, "DATA", 354);
    socket.write(`${formatMessage(message)}\r\n.\r\n`);
    assertSmtpCode(await readResponse(), 250);
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_SIZE) {
        reject(new Error("请求内容过大。"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function respond(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/send") {
    respond(response, 404, { error: "未找到请求地址。" });
    return;
  }

  const requestToken = Buffer.from(request.headers["x-video-reminder-token"] || "");
  const expectedToken = Buffer.from(bridgeToken);
  const tokenMatches = requestToken.length === expectedToken.length &&
    crypto.timingSafeEqual(requestToken, expectedToken);
  if (!tokenMatches) {
    respond(response, 401, { error: "连接密钥不正确。" });
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request));
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(to) || !subject || !text) {
      respond(response, 400, { error: "需要有效的收件邮箱地址、主题和正文。" });
      return;
    }

    await sendQqMail({ to, subject, text });
    respond(response, 200, { success: true });
  } catch (error) {
    console.error("QQ 邮件发送失败：", error.message);
    respond(response, 502, { error: error.message || "QQ 邮件发送失败。" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`QQ 邮箱服务已启动：http://${HOST}:${PORT}`);
  console.log("保持此窗口打开；在扩展面板填入显示的连接密钥后即可发送邮件。");
});
