require("dotenv").config();
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password || password.length < 12) {
    throw new Error("Set ADMIN_USERNAME and ADMIN_PASSWORD (at least 12 characters) in .env before creating an admin.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.upsert({
    where: { username },
    update: { passwordHash, role: "ADMIN", fullName: "Academy Administrator" },
    create: { username, passwordHash, role: "ADMIN", fullName: "Academy Administrator" }
  });
  console.log(`Admin account ready: ${admin.username}`);
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => prisma.$disconnect());
