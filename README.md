# NextGen Academy — Full-Stack Starter

This project adds an Express backend, Prisma database, hashed student passwords, server-side sessions, student dashboard APIs, admin endpoints, invoices, and PayPal Checkout order/capture routes to the NextGen Academy frontend.

## Requirements
- Node.js 20+
- npm
- PayPal Developer account for checkout testing (optional until you configure payments)

## Setup on Windows (PowerShell) or macOS/Linux

1. Extract this ZIP and open a terminal in the extracted `nextgen_academy_fullstack` folder.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and set a strong random `SESSION_SECRET`, your `ADMIN_USERNAME`, and a strong `ADMIN_PASSWORD` (at least 12 characters).
   - Windows PowerShell: `Copy-Item .env.example .env`
   - macOS/Linux: `cp .env.example .env`
4. Create the local SQLite database:
   ```bash
   npm run db:push
   ```
5. Create your administrator account:
   ```bash
   npm run admin:create
   ```
6. Start the app:
   ```bash
   npm start
   ```
7. Open http://localhost:3000.

## What is implemented
- Public landing page and course cards
- Real login with bcrypt password hashes and HttpOnly session cookie
- Student dashboard populated from the database
- Admin API to create students, courses, enrollments, and invoices
- Per-student invoice visibility
- PayPal Orders v2 create/capture endpoints
- Server-side verification of PayPal capture status, amount, currency, invoice, and student ownership
- Login/payment rate limits and basic security headers

## Admin API (sign in as an administrator first)
All endpoints use the same session cookie and require role `ADMIN`.

### Create a student
`POST /api/admin/students`
```json
{"username":"student01","password":"Use-A-Strong-Unique-Password","fullName":"Sample Student"}
```

### Create a course
`POST /api/admin/courses`
```json
{"slug":"linux-fundamentals","title":"Linux Fundamentals","description":"Linux command line and system administration basics.","price":250}
```

### Enroll a student
`POST /api/admin/enrollments`
```json
{"username":"student01","courseSlug":"devops-engineering-bootcamp","progress":0}
```

### Create a tuition invoice
`POST /api/admin/invoices`
```json
{"username":"student01","description":"DevOps Bootcamp Tuition","total":1200}
```

You can call these from an API client (such as curl or Postman) after signing in, or build an admin UI for them. The frontend currently includes student-facing pages; it does not yet include an admin management interface.

## Configure PayPal sandbox
1. Create a REST app in the PayPal Developer Dashboard and obtain its sandbox Client ID and Secret.
2. Put these values in `.env`:
   ```env
   PAYPAL_CLIENT_ID=your_sandbox_client_id
   PAYPAL_CLIENT_SECRET=your_sandbox_secret
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_CURRENCY=USD
   ```
3. Restart the server and test using PayPal sandbox buyer accounts.
4. For production, change the base URL to `https://api-m.paypal.com`, use live credentials, deploy only over HTTPS, and configure a verified public `APP_ORIGIN`.

The PayPal secret must only be stored on the server. Do not put it in frontend JavaScript or commit `.env`.

## Important production checklist
This is a starter, not a fully audited production system. Before handling real student information or money:
- Deploy behind HTTPS and set `NODE_ENV=production`, strong secret values, and an exact `APP_ORIGIN`.
- Configure a strict Content Security Policy (the starter disables CSP to allow the inline PayPal SDK and can be hardened).
- Consider PostgreSQL instead of SQLite for a multi-user production deployment.
- Add CSRF protection appropriate to your deployment, email verification, password reset, account lockout/monitoring, and backup/retention policies.
- Add PayPal webhook verification and reconciliation for resilient payment tracking.
- Add an admin UI and audit logging; restrict admin accounts and rotate credentials.
- Confirm course prices, invoice rules, refunds, taxes, privacy notice, and terms with your business.
- Review dependencies and security before launch.

The frontend has no demo hard-coded credentials. Create students through the admin API; do not reuse example passwords.
