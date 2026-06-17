# Podcast Studio Audio Router (Selective-Mesh WebRTC)

A lightweight, no-install mobile web application designed to handle the specific mix-minus audio routing needs of a podcast studio with three local hosts and one remote guest.

## 📡 Routing Architecture

To prevent audio feedback loops and latency in the studio, the application uses a **Selective-Mesh WebRTC** topology. Rather than a full mesh where everyone connects to everyone:
* **Remote Guest** establishes a bi-directional connection to **Host 1, 2, and 3**.
* **Hosts 1-3** only connect to the Guest. They do **not** connect to each other.
* This ensures that local studio hosts (who can hear each other naturally in the room) only receive the remote guest's audio, and the guest receives a mix of all three hosts.

---

## 🛠️ Development Mode Instructions

### 1. Prerequisites & Installation
Ensure you have [Node.js](https://nodejs.org/) installed, clone the repository, and install dependencies:
```bash
npm install
```

### 2. Running the Server Locally
To start the signaling and static file server:
```bash
npm start
```
By default, the server runs on port **`3003`** (or checks the `PORT` environment variable).
* Local access: `http://localhost:3003`

### 3. Simulating/Testing Locally
Open multiple browser tabs or devices on your network:
* Open tab 1: Select **Host 1**
* Open tab 2: Select **Remote Guest**
* The connection indicators will turn green (`Session Active`), and audio level meters will begin rendering dynamically.

### 4. Shutting Down the Server
* **Interactive Mode:** Focus on the terminal window and press **`Ctrl + C`**.
* **Background Mode (Kill by Port):** If the server was run in the background or terminal was closed:
  ```bash
  fuser -k 3003/tcp
  ```
* **Kill all Node processes:**
  ```bash
  pkill node
  ```

---

## 🌐 Overcoming Network Restrictions (Wi-Fi Isolation & Firewalls)

When testing on public, university, or corporate Wi-Fi networks, you may encounter connectivity issues:
1. **AP/Client Isolation:** Router prevents devices on the same Wi-Fi from talking to each other (local hosts can't reach the PC's IP).
2. **Firewall Web Filtering (e.g., Fortinet):** Firewall blocks tunnels like Ngrok with security warnings (`net::ERR_CERT_AUTHORITY_INVALID`).

### Easiest Workaround: Mobile Hotspot
1. Turn on a **Wi-Fi Hotspot** on a mobile phone (using cellular data).
2. Connect your Studio PC and the hosts' phones to this hotspot.
3. This creates a direct local network with no blocks or AP isolation.

### SSH Tunneling (Alternative to Ngrok)
If you cannot use a hotspot and Fortinet is blocking Ngrok, run a tunnel over standard SSH using the free `localhost.run` service:
```bash
ssh -o StrictHostKeyChecking=no -R 80:localhost:3003 nokey@localhost.run
```
*Have local hosts and guests turn off Wi-Fi on their phones and connect to the generated public HTTPS link using their **4G/5G cellular data** to bypass local network blocks.*

---

## 🚀 Production Mode Instructions

To deploy this in your university cloud or public hosting behind an Apache reverse proxy:

### 1. SSL/HTTPS Requirement (Mandatory)
Browsers strictly block microphone access (`navigator.mediaDevices.getUserMedia`) on insecure origins. The production server **must** be served over **HTTPS** with a valid SSL certificate.

### 2. Apache Reverse Proxy Configuration
You must proxy both standard HTTP traffic and upgrade WebSocket connection requests (`ws://` / `wss://`). Enable the required modules:
```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
```

Add the following configuration to your VirtualHost file:
```apache
<VirtualHost *:80>
    ServerName audio.youruniversity.edu
    Redirect permanent / https://audio.youruniversity.edu/
</VirtualHost>

<VirtualHost *:443>
    ServerName audio.youruniversity.edu

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/audio.youruniversity.edu/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/audio.youruniversity.edu/privkey.pem

    ProxyRequests Off
    ProxyPreserveHost On

    # Proxy WebSocket Traffic first (Signaling)
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/(.*)           ws://localhost:3003/$1 [P,L]

    # Proxy HTTP Traffic (Frontend Files)
    ProxyPass / http://localhost:3003/
    ProxyPassReverse / http://localhost:3003/

    # Security Headers for Device Access Permissions
    Header always set Referrer-Policy "no-referrer-when-downgrade"
    Header always set Feature-Policy "microphone 'self'"
</VirtualHost>
```

### 3. Handling Strict Firewalls (TURN Server Fallback)
If university clients fail to establish audio routes (connections stay on `Connecting...` or `Failed`), firewalls are likely blocking direct UDP streams.
To resolve this:
1. Set up a Coturn server on your cloud node.
2. Update the WebRTC configuration array in `public/app.js` to include your TURN credential credentials:
   ```javascript
   const rtcConfig = {
     iceServers: [
       { urls: 'stun:stun.l.google.com:19302' },
       { 
         urls: 'turn:your-turn-server.edu:3478',
         username: 'your-username',
         credential: 'your-password'
       }
     ]
   };
   ```
