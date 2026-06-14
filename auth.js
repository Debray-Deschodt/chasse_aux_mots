import { betterAuth } from "better-auth";
import { LibsqlDialect } from "@libsql/kysely-libsql";

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const auth = betterAuth({
  appName: "Chasse au mot",
  baseURL: BASE_URL,
  // Mets une vraie valeur en prod : openssl rand -base64 32
  secret: process.env.AUTH_SECRET || "dev-secret-please-change-me-32chars+xx",
  database: {
    dialect: new LibsqlDialect({ url: process.env.AUTH_DB || "file:./auth.db" }),
    type: "sqlite",
  },
  trustedOrigins: [BASE_URL],
  emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
  socialProviders: hasGoogle ? {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  } : {},
  // "Rester connecté" : session de 30 jours, prolongée à chaque jour d'activité
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
});
