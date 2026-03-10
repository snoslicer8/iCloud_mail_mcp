# iCloud_mail_mcp
A lightweight MCP server to authorize AI tools such as Claude to interface with iCloud email over SMTP. I am running this through Container Manager on my Synology DS1525+ NAS. Claude talks to it through the Cloudflare tunnel and triages my inbox (or any other folder I ask him to).

### Installation ###

Best run as a Docker container.

Clone entire directory to where you'd like to run it from.

Copy .env.example to .env, edit to add your iCloud user ID, an app-specific password for your iCloud account (see account.apple.com), a random 32 digit hex string, and your Cloudflare tunnel token (optional if setting up).

Edit docker-compose.yml for your preferred ports.
