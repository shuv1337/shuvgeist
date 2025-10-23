import crypto from "node:crypto";
import bcrypt from "bcrypt";
import type { Request, Response } from "express";
import { sealData } from "iron-session";
import type { Api, AuthRequest, HealthResponse, StatusResponse } from "../shared/api.js";
import type { EmailSignup, SignupRequest, SignupResponse } from "../shared/types.js";
import { getIronConfig, type SessionData } from "./auth-middleware.js";
import type { SettingsManager } from "./settings.js";
import type { FileStore } from "./storage.js";

// Email validation regex (basic)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create API handlers
 */
export function createHandlers(signupsStore: FileStore<EmailSignup[] | string>, settings: SettingsManager): Api {
	return {
		async health(): Promise<HealthResponse> {
			return {
				status: "healthy",
				timestamp: new Date().toISOString(),
			};
		},

		async status(): Promise<StatusResponse> {
			return {
				setupRequired: settings.isSetupRequired(),
			};
		},

		async setup(request: AuthRequest, _req: Request, res: Response): Promise<void> {
			// Check if already set up
			if (!settings.isSetupRequired()) {
				throw new Error("Setup already completed");
			}

			const { password } = request;

			if (!password || password.length < 6) {
				throw new Error("Password must be at least 6 characters");
			}

			// Hash password and generate Iron secret
			const passwordHash = await bcrypt.hash(password, 10);
			const ironSecret = crypto.randomBytes(32).toString("base64");

			// Save settings
			settings.setAuth(passwordHash, ironSecret);

			// Create session cookie
			const sessionData: SessionData = { authenticated: true };
			const sealed = await sealData(sessionData, { password: ironSecret });

			const config = getIronConfig(ironSecret);
			res.cookie(config.cookieName, sealed, config.cookieOptions);

			console.log("✓ Setup completed, admin session created");
		},

		async login(request: AuthRequest, _req: Request, res: Response): Promise<void> {
			const { password } = request;

			// Check if setup is required first
			if (settings.isSetupRequired()) {
				throw new Error("Setup required");
			}

			const passwordHash = settings.getPasswordHash();
			const ironSecret = settings.getIronSecret();

			if (!passwordHash || !ironSecret) {
				throw new Error("Setup required");
			}

			// Verify password
			const valid = await bcrypt.compare(password, passwordHash);
			if (!valid) {
				throw new Error("Invalid password");
			}

			// Create session cookie
			const sessionData: SessionData = { authenticated: true };
			const sealed = await sealData(sessionData, { password: ironSecret });

			const config = getIronConfig(ironSecret);
			res.cookie(config.cookieName, sealed, config.cookieOptions);

			console.log("✓ Admin logged in");
		},

		async logout(_body: unknown, _req: Request, res: Response): Promise<void> {
			const ironSecret = settings.getIronSecret();
			if (!ironSecret) {
				throw new Error("Setup required");
			}

			const config = getIronConfig(ironSecret);
			res.clearCookie(config.cookieName);

			console.log("✓ Admin logged out");
		},

		async signup(request: SignupRequest): Promise<SignupResponse> {
			const { email } = request;

			// Validate email format
			if (!email || typeof email !== "string") {
				throw new Error("Email is required");
			}

			if (!EMAIL_REGEX.test(email)) {
				throw new Error("Invalid email format");
			}

			// Get current signups array
			const signups = (signupsStore.getItem("signups") as EmailSignup[]) || [];

			// Check if email already exists
			const existingSignup = signups.find((signup) => signup.email.toLowerCase() === email.toLowerCase());

			if (existingSignup) {
				// Don't reveal that email is already registered - return success
				console.log(`✓ Duplicate signup attempt: ${email}`);
				return {
					success: true,
				};
			}

			// Create new signup
			const signup: EmailSignup = {
				email: email.toLowerCase(),
				timestamp: new Date().toISOString(),
				notified: false,
			};

			// Add to array and save
			signups.push(signup);
			signupsStore.setItem("signups", signups);

			console.log(`✓ New signup: ${signup.email}`);

			return {
				success: true,
			};
		},

		async listSignups(): Promise<EmailSignup[]> {
			const signups = (signupsStore.getItem("signups") as EmailSignup[]) || [];
			return signups;
		},
	};
}
