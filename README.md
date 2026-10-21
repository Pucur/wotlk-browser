# 🌐 WotLK Browser

**A browser-based delivery and connectivity layer for World of Warcraft: Wrath of the Lich King (WotLK).**

WotLK Browser provides the infrastructure needed to deliver client files through the web, stream game data, and bridge browser-based WebSocket connections to traditional TCP game services.

## ✨ Features

- 🌍 **Web Client Delivery** — Serves client files and resources over HTTPS.
- 📦 **Game Data Streaming** — Supports block-based data delivery and HTTP byte-range requests.
- 🔌 **WebSocket-to-TCP Tunnel** — Bridges browser WebSocket connections to TCP-based game services.
- 🔀 **Configurable Routing** — Supports configurable realm destinations, allowed ports, and destination redirects.
- 👤 **Account Management** — Provides account registration, authentication, account information, and credential management endpoints.
- 🔐 **Session Management** — Handles login sessions and account authentication.
- 🗄️ **MySQL Integration** — Uses a MySQL-compatible database for account-related operations.
- 📊 **Diagnostics and Logging** — Provides logging and debugging capabilities for troubleshooting connections and requests.
- ⚙️ **Environment-Based Configuration** — Allows server settings, file paths, network destinations, and database credentials to be configured through environment variables.

## 🏗️ Architecture

| Component | Description |
|---|---|
| Web Client | Browser-side client and supporting resources |
| Bridge Server | HTTPS file delivery, game data streaming, and WebSocket-to-TCP tunneling |
| Account Backend | Authentication, registration, and session management |
| MySQL Database | Account and session data storage |

## 🛠️ Technology Stack

- Node.js
- JavaScript (ES Modules)
- Express
- HTTPS / TLS
- WebSockets
- TCP networking
- MySQL
- WebAssembly-based client resources

## 🚀 Getting Started

### Prerequisites

Before deploying the project, make sure you have:

- A compatible Node.js runtime
- The required project dependencies
- The necessary client files and game data
- A configured MySQL database
- Valid TLS certificates for HTTPS deployments
- Access to a compatible WotLK game server

### Installation

Clone the repository:

```bash
git clone https://github.com/Pucur/wotlk-browser.git
cd wotlk-browser
```

Install the project dependencies using the package manager and instructions applicable to the relevant project directory.

Configure the required environment variables, database connection, client data paths, and game server destinations before starting the services.

> **Note:** Exact startup commands and configuration requirements depend on the current project structure and deployment setup.

Use the slicer app to slice up to 64Kb chunks the game (enUS version) in the web/game folder, it will slice into the web/blocks folder

```bash
python3 web/slicer.py
```

After you succesfully sliced up the app, you can run the npm bridge (it redirects the server to the real server)

## Examples

```bash
HOST=0.0.0.0 REALM_HOSTS=127.0.0.1,IP1 node bridge.mjs --trace
```
```bash
HOST=0.0.0.0 REALM_HOSTS=127.0.0.1,IP1,IP2 REALM_PORTS=3724,8086 REDIRECT_3724=IP1 REDIRECT_8085=IP2 node bridge.mjs --trace
```

## 🔒 Security

When deploying this project publicly:

- Use HTTPS and valid TLS certificates.
- Restrict tunnel destinations and permitted ports.
- Keep database credentials and secrets out of version control.
- Limit database permissions to what the application requires.
- Avoid exposing internal services directly to the public internet.
- Validate account authentication and session handling.

# Account Manager (Untested)

## Installation

```bash
npm install
mysql -u acore -p acore_auth < schema.sql
```

## Configuration

Set these environment variables (all optional, the defaults are in `server.mjs`):

| Variable   | Default     | Description           |
|------------|-------------|-----------------------|
| `DB_HOST`  | `127.0.0.1` | MySQL host            |
| `DB_PORT`  | `3306`      | MySQL port            |
| `DB_USER`  | `acore`     | MySQL user            |
| `DB_PASS`  | *(empty)*   | MySQL password        |
| `AUTH_DB`  | `acore_auth`| Auth database name    |
| `PORT`     | `3000`      | HTTP port             |

## Running

```bash
DB_PASS=yourpassword npm start
```

## API

All endpoints accept `POST` with JSON or form-urlencoded bodies. Responses are
plain text, one value per line. The first line is `OK` on success.

| Endpoint             | Request fields                | Response                                    |
|----------------------|-------------------------------|---------------------------------------------|
| `/account/register`  | `user`, `salt`, `verifier`, `email` | `OK`                                 |
| `/account/challenge` | `user`                        | `OK`, `id`, `salt`, `B`                     |
| `/account/login`     | `id`, `a`, `m1`               | `OK`, `token`, account info lines           |
| `/account/password`  | `user`, `token`, `salt`, `verifier` | `OK`                                  |
| `/account/email`     | `token`, `email`              | `OK`                                        |
| `/account/info`      | `token`                       | `OK`, account info lines                    |

Error responses use an HTTP status code and a single line, for example
`401 WRONG_PASSWORD` or `409 USERNAME_TAKEN`.

## Login flow

1. The client sends the username to `/account/challenge` and receives a salt
   and the server's public value `B`.
2. The client computes `A` and the proof `M1` from the password, salt, and `B`.
3. The client sends `id`, `A` (as `a`), and `M1` (as `m1`) to `/account/login`.
4. On success, the server returns a session `token` for the other endpoints.

## 📄 License

See the [`MIT LICENSE`](LICENSE) file if one is included in the repository.
