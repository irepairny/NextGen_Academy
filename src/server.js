require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { PrismaClient } = require("@prisma/client");
const { z } = require("zod");

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = "nextgen_session";
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 7));
const secureCookies = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for the starter's inline frontend; configure CSP before production.
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many login attempts. Please try again later." } });
const paymentLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function safeUser(user) {
  return { id: user.id, username: user.username, fullName: user.fullName, role: user.role };
}
function centsToAmount(cents) { return (cents / 100).toFixed(2); }
function amountToCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100000) {
    throw Object.assign(new Error("Enter a valid payment amount."), { status: 400 });
  }
  return Math.round(value * 100);
}
function requireConfig(...keys) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) throw Object.assign(new Error(`Server configuration missing: ${missing.join(", ")}`), { status: 503 });
}
async function currentUser(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { id: token }, include: { user: true } });
  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: token } }).catch(() => {});
    return null;
  }
  return session.user;
}
async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in." });
    req.user = user;
    next();
  } catch (e) { next(e); }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Administrator access required." });
  next();
}
function assertSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin && process.env.APP_ORIGIN && origin !== process.env.APP_ORIGIN) {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  next();
}
app.use("/api", assertSameOrigin);

app.get("/api/health", (req, res) => res.json({ ok: true, service: "nextgen-academy" }));

app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Enter your username and password." });
  const user = await prisma.user.findUnique({ where: { username: input.data.username } });
  if (!user || !(await bcrypt.compare(input.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: token, userId: user.id, expiresAt } });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: "lax", path: "/", expires: expiresAt });
  res.json({ user: safeUser(user) });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await prisma.session.deleteMany({ where: { id: token } });
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookies, sameSite: "lax", path: "/" });
  res.json({ ok: true });
}));

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in." });
  res.json({ user: safeUser(user) });
}));

app.get("/api/courses", asyncRoute(async (req, res) => {
  const courses = await prisma.course.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } });
  res.json({ courses: courses.map(c => ({ id: c.id, slug: c.slug, title: c.title, description: c.description, price: centsToAmount(c.priceCents) })) });
}));

app.get("/api/student/dashboard", requireAuth, asyncRoute(async (req, res) => {
  const [enrollments, invoices, payments] = await Promise.all([
    prisma.enrollment.findMany({ where: { userId: req.user.id }, include: { course: true }, orderBy: { createdAt: "asc" } }),
    prisma.invoice.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } }),
    prisma.payment.findMany({ where: { userId: req.user.id, status: "COMPLETED" }, orderBy: { createdAt: "desc" }, take: 20 })
  ]);
  const totalCents = invoices.reduce((sum, i) => sum + i.totalCents, 0);
  const paidCents = invoices.reduce((sum, i) => sum + i.paidCents, 0);
  res.json({
    user: safeUser(req.user),
    courses: enrollments.map(e => ({ id: e.course.id, slug: e.course.slug, title: e.course.title, description: e.course.description, progress: e.progress, status: e.status })),
    tuition: { total: centsToAmount(totalCents), paid: centsToAmount(paidCents), balance: centsToAmount(Math.max(0, totalCents - paidCents)), invoices: invoices.map(i => ({ id: i.id, description: i.description, total: centsToAmount(i.totalCents), paid: centsToAmount(i.paidCents), balance: centsToAmount(Math.max(0, i.totalCents - i.paidCents)), status: i.status, createdAt: i.createdAt })) },
    payments: payments.map(p => ({ id: p.id, amount: centsToAmount(p.amountCents), currency: p.currency, status: p.status, createdAt: p.createdAt }))
  });
}));

async function paypalAccessToken() {
  requireConfig("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET");
  const base = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw Object.assign(new Error("Could not authenticate with PayPal."), { status: 502 });
  return { token: data.access_token, base };
}
async function paypalRequest(endpoint, method, token, body) {
  const { base } = await paypalAccessToken();
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": crypto.randomUUID() },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || "PayPal request failed.");
    err.status = 502;
    throw err;
  }
  return data;
}

// Creates an order only for the signed-in user's own outstanding invoice.
app.post("/api/payments/paypal/create-order", requireAuth, paymentLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ invoiceId: z.string().min(1), amount: z.number().positive().optional() }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Invoice and a valid amount are required." });
  const invoice = await prisma.invoice.findFirst({ where: { id: input.data.invoiceId, userId: req.user.id } });
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });
  const outstanding = invoice.totalCents - invoice.paidCents;
  if (outstanding <= 0 || invoice.status === "PAID") return res.status(400).json({ error: "This invoice is already paid." });
  const amountCents = input.data.amount === undefined ? outstanding : amountToCents(input.data.amount);
  if (amountCents > outstanding) return res.status(400).json({ error: "Payment cannot exceed the outstanding invoice balance." });
  const { token, base } = await paypalAccessToken();
  const currency = process.env.PAYPAL_CURRENCY || "USD";
  const response = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": crypto.randomUUID() },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: invoice.id, custom_id: req.user.id, invoice_id: invoice.id, description: invoice.description.slice(0, 127), amount: { currency_code: currency, value: centsToAmount(amountCents) } }],
      application_context: { brand_name: "NextGen Academy", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" }
    })
  });
  const order = await response.json().catch(() => ({}));
  if (!response.ok || !order.id) throw Object.assign(new Error(order.message || "Could not create PayPal order."), { status: 502 });
  await prisma.payment.create({ data: { userId: req.user.id, invoiceId: invoice.id, providerOrderId: order.id, amountCents, currency, status: "CREATED" } });
  res.json({ orderId: order.id });
}));

// Captures the order and verifies amount/currency/ownership from PayPal's response before crediting the invoice.
app.post("/api/payments/paypal/capture-order", requireAuth, paymentLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ orderId: z.string().min(1).max(100) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "A PayPal order ID is required." });
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: input.data.orderId }, include: { invoice: true } });
  if (!payment || payment.userId !== req.user.id) return res.status(404).json({ error: "Payment order not found." });
  if (payment.status === "COMPLETED") return res.json({ ok: true, status: "COMPLETED" });
  const { token, base } = await paypalAccessToken();
  const response = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(payment.providerOrderId)}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `capture-${payment.providerOrderId}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== "COMPLETED") throw Object.assign(new Error(result.message || "PayPal did not complete this payment."), { status: 502 });
  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  const unit = result.purchase_units?.[0];
  if (!capture || capture.status !== "COMPLETED" || unit?.custom_id !== req.user.id || unit?.reference_id !== payment.invoiceId ||
      capture.amount?.currency_code !== payment.currency || Math.round(Number(capture.amount?.value) * 100) !== payment.amountCents) {
    throw Object.assign(new Error("PayPal capture details did not match the expected payment."), { status: 409 });
  }
  await prisma.$transaction(async tx => {
    const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
    if (fresh.status === "COMPLETED") return;
    const invoice = await tx.invoice.findUnique({ where: { id: payment.invoiceId } });
    if (!invoice) throw new Error("Invoice not found.");
    const paidCents = Math.min(invoice.totalCents, invoice.paidCents + payment.amountCents);
    await tx.invoice.update({ where: { id: invoice.id }, data: { paidCents, status: paidCents >= invoice.totalCents ? "PAID" : "PARTIAL" } });
    await tx.payment.update({ where: { id: payment.id }, data: { status: "COMPLETED", captureId: capture.id } });
  });
  res.json({ ok: true, status: "COMPLETED", captureId: capture.id });
}));

// Admin can create students and invoices. Admin account is created with `npm run admin:create`.
app.use("/api/admin", requireAuth, requireAdmin);
app.post("/api/admin/students", asyncRoute(async (req, res) => {
  const parsed = z.object({ username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/), password: z.string().min(12).max(200), fullName: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a username, full name, and password of at least 12 characters." });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  try {
    const user = await prisma.user.create({ data: { username: parsed.data.username, fullName: parsed.data.fullName, passwordHash, role: "STUDENT" } });
    res.status(201).json({ user: safeUser(user) });
  } catch (e) { if (e.code === "P2002") return res.status(409).json({ error: "Username already exists." }); throw e; }
}));
app.post("/api/admin/courses", asyncRoute(async (req, res) => {
  const parsed = z.object({ slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/), title: z.string().trim().min(3).max(120), description: z.string().trim().min(5).max(2000), price: z.number().nonnegative().max(100000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid course data." });
  const course = await prisma.course.create({ data: { ...parsed.data, priceCents: Math.round(parsed.data.price * 100) } }).catch(e => { if (e.code === "P2002") return null; throw e; });
  if (!course) return res.status(409).json({ error: "Course slug already exists." });
  res.status(201).json({ course });
}));
app.post("/api/admin/enrollments", asyncRoute(async (req, res) => {
  const parsed = z.object({ username: z.string(), courseSlug: z.string(), progress: z.number().int().min(0).max(100).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid enrollment data." });
  const [user, course] = await Promise.all([prisma.user.findUnique({ where: { username: parsed.data.username } }), prisma.course.findUnique({ where: { slug: parsed.data.courseSlug } })]);
  if (!user || !course) return res.status(404).json({ error: "Student or course not found." });
  const enrollment = await prisma.enrollment.upsert({ where: { userId_courseId: { userId: user.id, courseId: course.id } }, update: { progress: parsed.data.progress ?? 0 }, create: { userId: user.id, courseId: course.id, progress: parsed.data.progress ?? 0 } });
  res.status(201).json({ enrollment });
}));
app.post("/api/admin/invoices", asyncRoute(async (req, res) => {
  const parsed = z.object({ username: z.string(), description: z.string().trim().min(3).max(200), total: z.number().positive().max(100000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a username, invoice description, and positive total." });
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (!user) return res.status(404).json({ error: "Student not found." });
  const invoice = await prisma.invoice.create({ data: { userId: user.id, description: parsed.data.description, totalCents: Math.round(parsed.data.total * 100) } });
  res.status(201).json({ invoice: { id: invoice.id, description: invoice.description, total: centsToAmount(invoice.totalCents), balance: centsToAmount(invoice.totalCents) } });
}));

app.get("/api/config/paypal", (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID || "", currency: process.env.PAYPAL_CURRENCY || "USD" });
});

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((err, req, res, next) => {
  console.error(err);
  const status = Number(err.status) || 500;
  res.status(status).json({ error: status >= 500 && process.env.NODE_ENV === "production" ? "An unexpected server error occurred." : err.message || "Server error." });
});

async function seedCourses() {
  const courses = [
    { slug: "devops-engineering-bootcamp", title: "DevOps Engineering Bootcamp", description: "Linux, Git, AWS, Docker, Kubernetes, Jenkins, CI/CD and practical deployment projects.", priceCents: 120000 },
    { slug: "computer-training", title: "Basic to Advanced Computer Training", description: "Computer fundamentals, Windows, Microsoft Office, internet skills, troubleshooting and IT support.", priceCents: 0 }
  ];
  for (const course of courses) await prisma.course.upsert({ where: { slug: course.slug }, update: { title: course.title, description: course.description }, create: course });
}
seedCourses().then(() => {
  app.listen(PORT, () => console.log(`NextGen Academy running at http://localhost:${PORT}`));
}).catch(err => { console.error("Startup failed:", err); process.exit(1); });

async function shutdown() { await prisma.$disconnect(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
