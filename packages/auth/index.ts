export { authConfig, getAuthConfig } from "./config";

export { hashPassword } from "./password/hash";
export { comparePassword } from "./password/compare";

export { generateAccessToken, generateRefreshToken } from "./tokens/generate";
export { verifyAccessToken, verifyRefreshToken } from "./tokens/verify";
export {
    invalidateAllUserTokens,
    invalidateUserToken,
    invalidateMultipleUserTokens,
    getUserTokenVersion,
    isTokenVersionValid,
} from "./tokens/invalidate";
export type { InvalidationReason, TokenInvalidationResult } from "./tokens/invalidate";

export { createUserSession } from "./session/create-session";
export { verifySession } from "./session/verify-session";

export { loginUser } from "./services/login.service";
export { registerService } from "./services/register.service";
export { refreshService } from "./services/refresh.service";
export { logoutService } from "./services/logout.service";
export { revokeUserAuthSessions } from "./services/revoke-user-auth.service";
export { changePasswordService, forcePasswordChangeService } from "./services/change-password.service";
export { completePasswordStepUpChallenge } from "./services/step-up-password.service";
export { completeOtpStepUpChallenge, requestOtpStepUpChallenge } from "./services/step-up-otp.service";
export { logAuthEventBestEffort } from "./services/auth-audit.service";
export { logSecurityEvent } from "./services/security-event-logger";
export { listAuthEvents } from "./services/list-auth-events.service";
export {
    createGoogleOAuthState,
    buildGoogleOAuthAuthorizeUrl,
    exchangeGoogleCodeForTokens,
    fetchGoogleUserProfile,
    loginWithGoogleCode,
} from "./services/google-oauth.service";
export {
    sendEmailOtpService,
    verifyEmailOtpService,
    verifyOtpAndRegisterService,
} from "./services/otp.service";

export { authenticateHttpBearer } from "./middleware/http-auth";
export { authenticateSocketToken } from "./middleware/socket-auth";
export { AuthStepUpRequiredError } from "./errors/auth-errors";

export {
    buildAccessTokenCookie,
    buildRefreshTokenCookie,
    buildExpiredCookie,
    parseCookieValue,
} from "./utils/cookie";

export type { AccessTokenPayload, RefreshTokenPayload } from "./tokens/types";
export type { AdminAuthEventGroup, AdminAuthEventItem } from "./services/list-auth-events.service";