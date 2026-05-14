/**
 * Authentication boundary detection heuristics.
 * 
 * Detects auth walls, captchas, and login requirements during crawling
 * WITHOUT bypassing them — emits diagnostics for the HITL flow to handle.
 */

import { Page, Response } from 'playwright';
import { logEvent } from '../observability/logger';
import { recordParseDiagnostic } from '../db/diagnostics';

export type AuthBoundaryType =
  | 'http_401'
  | 'http_403'
  | 'login_redirect'
  | 'login_form'
  | 'captcha_cloudflare'
  | 'captcha_recaptcha'
  | 'captcha_hcaptcha'
  | 'auth_required_text';

export interface AuthBoundaryEvent {
  type: AuthBoundaryType;
  url: string;
  confidence: number;
  details?: string;
}

/**
 * Check an HTTP response for auth-boundary status codes (401, 403).
 */
export function detectHttpAuthBoundary(url: string, status: number): AuthBoundaryEvent | null {
  if (status === 401) {
    return { type: 'http_401', url, confidence: 1.0, details: 'HTTP 401 Unauthorized' };
  }
  if (status === 403) {
    return { type: 'http_403', url, confidence: 0.9, details: 'HTTP 403 Forbidden' };
  }
  return null;
}

/**
 * Check if a navigation resulted in a redirect to a login/auth page.
 */
export function detectLoginRedirect(currentUrl: string, originalUrl: string): AuthBoundaryEvent | null {
  if (currentUrl === originalUrl) return null;

  const loginPatterns = [
    /\/login/i,
    /\/signin/i,
    /\/sign-in/i,
    /\/auth/i,
    /\/authenticate/i,
    /\/sso/i,
    /\/oauth/i,
    /\/accounts\/login/i,
    /\/session\/new/i,
  ];

  for (const pattern of loginPatterns) {
    if (pattern.test(currentUrl) && !pattern.test(originalUrl)) {
      return {
        type: 'login_redirect',
        url: currentUrl,
        confidence: 0.95,
        details: `Redirected from ${originalUrl} to login page`,
      };
    }
  }
  return null;
}

/**
 * Detect captcha presence by analyzing page content.
 * Checks for Cloudflare Turnstile, reCAPTCHA, and hCaptcha markers.
 */
export async function detectCaptcha(page: Page): Promise<AuthBoundaryEvent | null> {
  try {
    const html = await page.content();
    const url = page.url();

    // Cloudflare Turnstile / challenge
    if (
      html.includes('challenges.cloudflare.com') ||
      html.includes('cf-turnstile') ||
      html.includes('cf-challenge') ||
      html.includes('_cf_chl_opt')
    ) {
      return {
        type: 'captcha_cloudflare',
        url,
        confidence: 0.95,
        details: 'Cloudflare challenge/Turnstile detected',
      };
    }

    // Google reCAPTCHA
    if (
      html.includes('google.com/recaptcha') ||
      html.includes('g-recaptcha') ||
      html.includes('grecaptcha')
    ) {
      return {
        type: 'captcha_recaptcha',
        url,
        confidence: 0.95,
        details: 'Google reCAPTCHA detected',
      };
    }

    // hCaptcha
    if (
      html.includes('hcaptcha.com') ||
      html.includes('h-captcha')
    ) {
      return {
        type: 'captcha_hcaptcha',
        url,
        confidence: 0.95,
        details: 'hCaptcha detected',
      };
    }
  } catch {
    // Page may have navigated away — non-fatal
  }
  return null;
}

/**
 * Detect login forms or auth-required text patterns on the page.
 */
export async function detectLoginForm(page: Page): Promise<AuthBoundaryEvent | null> {
  try {
    const url = page.url();

    // Check for password input fields (strong indicator)
    const hasPasswordField = await page.$('input[type="password"]') !== null;
    if (hasPasswordField) {
      return {
        type: 'login_form',
        url,
        confidence: 0.9,
        details: 'Password input field detected',
      };
    }

    // Check page text for auth-required patterns
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || '');
    const authTextPatterns = [
      /please\s+(log|sign)\s*in/i,
      /you\s+must\s+(log|sign)\s*in/i,
      /authentication\s+required/i,
      /access\s+denied/i,
      /unauthorized/i,
      /login\s+to\s+continue/i,
      /sign\s+in\s+to\s+continue/i,
      /session\s+expired/i,
      /your\s+session\s+has\s+expired/i,
    ];

    for (const pattern of authTextPatterns) {
      if (pattern.test(bodyText)) {
        return {
          type: 'auth_required_text',
          url,
          confidence: 0.7,
          details: `Auth-required text matched: ${pattern.source}`,
        };
      }
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Run the full auth boundary detection suite against a page after navigation.
 * Returns the first detected boundary, or null if the page is clear.
 */
export async function detectAuthBoundary(
  page: Page,
  originalUrl: string,
  navigationResponse: Response | null,
): Promise<AuthBoundaryEvent | null> {
  // 1. HTTP status code check
  if (navigationResponse) {
    const httpBoundary = detectHttpAuthBoundary(page.url(), navigationResponse.status());
    if (httpBoundary) {
      logEvent('auth_boundary_detected', { type: httpBoundary.type, url: httpBoundary.url });
      recordParseDiagnostic('auth', page.url(), httpBoundary.details || httpBoundary.type);
      return httpBoundary;
    }
  }

  // 2. Login redirect detection
  const redirectBoundary = detectLoginRedirect(page.url(), originalUrl);
  if (redirectBoundary) {
    logEvent('auth_boundary_detected', { type: redirectBoundary.type, url: redirectBoundary.url });
    recordParseDiagnostic('auth', page.url(), redirectBoundary.details || redirectBoundary.type);
    return redirectBoundary;
  }

  // 3. Captcha detection
  const captchaBoundary = await detectCaptcha(page);
  if (captchaBoundary) {
    logEvent('captcha_detected', { type: captchaBoundary.type, url: captchaBoundary.url });
    recordParseDiagnostic('auth', page.url(), captchaBoundary.details || captchaBoundary.type);
    return captchaBoundary;
  }

  // 4. Login form / auth text detection
  const formBoundary = await detectLoginForm(page);
  if (formBoundary) {
    logEvent('auth_boundary_detected', { type: formBoundary.type, url: formBoundary.url });
    recordParseDiagnostic('auth', page.url(), formBoundary.details || formBoundary.type);
    return formBoundary;
  }

  return null;
}

/**
 * Checks if a given URL is a known authentication route that should be excluded
 * from autonomous crawling post-authentication.
 */
export function isAuthRoute(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();

    // Common auth paths
    if (
      path.includes('/login') ||
      path.includes('/signin') ||
      path.includes('/sign-in') ||
      path.includes('/logout') ||
      path.includes('/signout') ||
      path.includes('/register') ||
      path.includes('/signup') ||
      path.includes('/auth') ||
      path.includes('/oauth') ||
      path.includes('/sso') ||
      path.includes('/challenge') ||
      path.includes('/captcha')
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

