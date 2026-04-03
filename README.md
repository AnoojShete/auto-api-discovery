# ApiGen (auto-api-discovery)

[![NPM Version](https://img.shields.io/npm/v/auto-api-discovery)](https://www.npmjs.com/package/auto-api-discovery)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A CLI tool for automated API discovery. ApiGen intercepts browser network traffic (XHR, Fetch, GraphQL) to automatically build OpenAPI 3.0 specifications.

## Installation

Install the package globally via npm:

```bash
npm install -g auto-api-discovery
```

*(Note: The `postinstall` script will automatically download the Chromium binaries required by Playwright.)*

Alternatively, you can run it directly via `npx`:

```bash
npx auto-api-discovery capture https://example.com
```

## Usage

Once installed, the `apigen` CLI becomes available.

### 1. Capture API Traffic
Launch an interactive browser. You can manually log in, navigate the app, and bypass captchas. ApiGen intercepts the underlying API requests and saves them to a local SQLite database.

```bash
apigen capture https://example.com
```

### 2. Crawl Connected Pages (Auto-Spidering)
Use your previously captured authenticated session to automatically run a headless crawler. It discovers and logs additional API endpoints in the background.

```bash
apigen crawl https://example.com --depth 3 --pages 50
```

### 3. Export OpenAPI Schema
Convert the recorded API traffic into a unified OpenAPI 3.0 specification document. Dynamic IDs and UUIDs are automatically folded into path parameters.

```bash
apigen export ./openapi.json --base-url https://api.example.com
```

## How It Works
- Uses **Playwright** to proxy network requests and manage sessions.
- Stores metadata and traffic locally using **Better-SQLite3**.
- Automatically infers JSON payload structures and route schemas.
