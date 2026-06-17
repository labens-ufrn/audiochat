// WebRTC Selective-Mesh Audio Router Client Logic

let myRole = null;
let localStream = null;
let ws = null;
const peerConnections = new Map(); // key: peerRole -> value: RTCPeerConnection

// Web Audio API State
let audioContext = null;
let localAnalyser = null;
const remoteAnalysers = new Map(); // key: peerRole -> value: AnalyserNode
const activeVisualizers = new Map(); // key: canvasId -> value: renderLoopRef

// DOM Elements
const setupScreen = document.getElementById('setup-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const activeRoleBadge = document.getElementById('active-role-badge');
const connectionStatusDot = document.getElementById('connection-status-dot');
const connectionStatusText = document.getElementById('connection-status-text');
const micSelect = document.getElementById('mic-select');
const remotePeersGrid = document.getElementById('remote-peers-grid');
const peersPlaceholder = document.getElementById('peers-placeholder');
const audioReceivers = document.getElementById('audio-receivers');
const muteBtn = document.getElementById('mute-btn');
const leaveBtn = document.getElementById('leave-btn');

// Diagnostics Elements
const diagSignaling = document.getElementById('diag-signaling');
const diagPeers = document.getElementById('diag-peers');
const diagLatency = document.getElementById('diag-latency');

// WebRTC Configurations
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// Initialize pre-flight device list
async function initDevices() {
  try {
    // Request temporary permission to list full device labels
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(track => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(device => device.kind === 'audioinput');
    
    micSelect.innerHTML = '';
    audioInputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${index + 1}`;
      micSelect.appendChild(option);
    });
  } catch (err) {
    console.error('Error listing devices:', err);
    micSelect.innerHTML = '<option value="">Default Microphone (Access Denied)</option>';
  }
}

// Bind role buttons in the Setup Screen
document.querySelectorAll('.role-card').forEach(btn => {
  btn.addEventListener('click', async () => {
    myRole = btn.getAttribute('data-role');
    await startSession();
  });
});

// Start Session flow
async function startSession() {
  setupScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  
  // Format active role badge text
  const roleLabels = {
    'host-1': 'Host 1 (Local)',
    'host-2': 'Host 2 (Local)',
    'host-3': 'Host 3 (Local)',
    'guest': 'Remote Guest'
  };
  activeRoleBadge.textContent = `Role: ${roleLabels[myRole]}`;
  
  // Update status
  updateStatus('connecting', 'Initializing Audio...');

  // 1. Get audio media stream
  try {
    const selectedMicId = micSelect.value;
    const constraints = getAudioConstraints(selectedMicId);
    console.log('Requesting audio stream with constraints:', constraints);
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Enable Visualizer for Local Microphone
    setupAudioContext();
    setupLocalVisualizer();
  } catch (err) {
    console.error('Failed to get local microphone:', err);
    alert('Could not access microphone. Ensure microphone permissions are allowed and headphones are plugged in.');
    leaveSession();
    return;
  }

  // 2. Connect to Signaling Server
  connectSignaling();
}

// Get Audio Media Constraints based on toggle elements
function getAudioConstraints(deviceId) {
  const echo = document.getElementById('toggle-echo').checked;
  const noise = document.getElementById('toggle-noise').checked;
  const gain = document.getElementById('toggle-gain').checked;
  
  const constraints = {
    audio: {
      echoCancellation: echo,
      noiseSuppression: noise,
      autoGainControl: gain,
      latency: 0.005
    },
    video: false
  };

  if (deviceId) {
    constraints.audio.deviceId = { exact: deviceId };
  }
  
  return constraints;
}

// Initialize WebSocket signaling client
function connectSignaling() {
  updateStatus('connecting', 'Connecting to server...');
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const serverUrl = `${protocol}//${window.location.host}`;
  
  ws = new WebSocket(serverUrl);
  
  ws.onopen = () => {
    console.log('Connected to signaling server');
    diagSignaling.textContent = 'Connected';
    updateStatus('connecting', 'Registering role...');
    
    ws.send(JSON.stringify({
      type: 'register',
      role: myRole
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'registered':
          console.log('Registered successfully as:', data.role);
          updateStatus('connected', 'Session Active');
          handleRegisteredPeers(data.activePeers);
          break;
          
        case 'peer-joined':
          console.log('Peer joined:', data.role);
          handlePeerJoined(data.role);
          break;
          
        case 'peer-left':
          console.log('Peer left:', data.role);
          handlePeerLeft(data.role);
          break;
          
        case 'offer':
          console.log(`Received WebRTC offer from: ${data.sender}`);
          await handleOffer(data.sender, data.offer);
          break;
          
        case 'answer':
          console.log(`Received WebRTC answer from: ${data.sender}`);
          await handleAnswer(data.sender, data.answer);
          break;
          
        case 'candidate':
          console.log(`Received ICE candidate from: ${data.sender}`);
          await handleCandidate(data.sender, data.candidate);
          break;
          
        case 'error':
          console.error('Signaling error:', data.message);
          alert(`Server Error: ${data.message}`);
          leaveSession();
          break;
      }
    } catch (err) {
      console.error('Failed to process message:', err);
    }
  };

  ws.onclose = () => {
    console.log('Signaling server connection closed');
    diagSignaling.textContent = 'Offline';
    updateStatus('disconnected', 'Disconnected from server');
    
    // Auto reconnect if not manually disconnected
    if (myRole) {
      setTimeout(connectSignaling, 2000);
    }
  };

  ws.onerror = (error) => {
    console.error('Signaling socket error:', error);
  };
}

// Update connection status bar
function updateStatus(state, text) {
  connectionStatusDot.className = `status-dot ${state}`;
  connectionStatusText.textContent = text;
}

// Parse active peers map and build routing logic
function handleRegisteredPeers(activePeers) {
  // If we are guest, we should initiate connections to any active hosts
  if (myRole === 'guest') {
    activePeers.forEach(peerRole => {
      if (peerRole.startsWith('host-')) {
        initiateConnection(peerRole);
      }
    });
  }
  updatePeersCount();
}

// Handle peer joins
function handlePeerJoined(peerRole) {
  // Selective Routing Constraint:
  // Hosts only connect to the Guest.
  // Guest connects to all Hosts.
  if (myRole === 'guest') {
    // Guest initiates the PeerConnection
    initiateConnection(peerRole);
  } else if (myRole.startsWith('host-') && peerRole === 'guest') {
    // Host waits for the Guest's offer
    console.log('Guest joined. Waiting for offer...');
    createPeerCard(peerRole);
  }
  updatePeersCount();
}

// Handle peer disconnect
function handlePeerLeft(peerRole) {
  cleanupPeerConnection(peerRole);
  removePeerCard(peerRole);
  updatePeersCount();
}

// Initiate RTCPeerConnection (Guest Side)
async function initiateConnection(peerRole) {
  console.log(`[Guest] Initiating RTCPeerConnection to: ${peerRole}`);
  
  createPeerCard(peerRole);
  const pc = createPeerConnection(peerRole);
  
  // Add local track
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });
  
  try {
    const offer = await pc.createOffer();
    
    // Check for studio high quality settings
    const hqEnabled = document.getElementById('toggle-hq').checked;
    const modifiedSdp = setOpusParameters(offer.sdp, hqEnabled);
    
    await pc.setLocalDescription({ type: 'offer', sdp: modifiedSdp });
    
    ws.send(JSON.stringify({
      type: 'offer',
      target: peerRole,
      offer: pc.localDescription
    }));
  } catch (err) {
    console.error(`Failed to create WebRTC offer to ${peerRole}:`, err);
  }
}

// Handle incoming offers (Host Side)
async function handleOffer(sender, offer) {
  console.log(`[Host] Handling offer from ${sender}`);
  
  createPeerCard(sender);
  const pc = createPeerConnection(sender);
  
  // Add local track
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });
  
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    
    const hqEnabled = document.getElementById('toggle-hq').checked;
    const modifiedSdp = setOpusParameters(answer.sdp, hqEnabled);
    
    await pc.setLocalDescription({ type: 'answer', sdp: modifiedSdp });
    
    ws.send(JSON.stringify({
      type: 'answer',
      target: sender,
      answer: pc.localDescription
    }));
  } catch (err) {
    console.error(`Failed to handle WebRTC offer from ${sender}:`, err);
  }
}

// Handle incoming answers (Guest Side)
async function handleAnswer(sender, answer) {
  console.log(`[Guest] Handling answer from ${sender}`);
  const pc = peerConnections.get(sender);
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error(`Failed to set remote description for ${sender}:`, err);
    }
  }
}

// Handle incoming ICE candidates
async function handleCandidate(sender, candidate) {
  const pc = peerConnections.get(sender);
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`Failed to add ICE candidate from ${sender}:`, err);
    }
  }
}

// Core PeerConnection setup
function createPeerConnection(peerRole) {
  // Clean up if already exists
  cleanupPeerConnection(peerRole);
  
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(peerRole, pc);
  
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: 'candidate',
        target: peerRole,
        candidate: event.candidate
      }));
    }
  };
  
  pc.onconnectionstatechange = () => {
    console.log(`Connection state with ${peerRole}: ${pc.connectionState}`);
    const dot = document.getElementById(`status-dot-${peerRole}`);
    const label = document.getElementById(`status-label-${peerRole}`);
    
    if (dot && label) {
      dot.className = `status-dot ${pc.connectionState}`;
      label.textContent = pc.connectionState.charAt(0).toUpperCase() + pc.connectionState.slice(1);
    }
    
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeerConnection(peerRole);
      removePeerCard(peerRole);
      updatePeersCount();
    }
  };
  
  pc.ontrack = (event) => {
    console.log(`Received track from ${peerRole}:`, event.track);
    
    // Play Remote Audio Stream
    let audioEl = document.getElementById(`audio-${peerRole}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-${peerRole}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioReceivers.appendChild(audioEl);
    }
    audioEl.srcObject = event.streams[0];
    
    // Visualizer for Remote Audio track
    setupRemoteVisualizer(peerRole, event.streams[0]);
  };
  
  return pc;
}

// SDP Modifier to enforce 128kbps Opus High-Quality Audio
function setOpusParameters(sdp, hqEnabled) {
  if (!hqEnabled) return sdp;
  
  const lines = sdp.split('\r\n');
  let opusPayloadType = null;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('a=rtpmap:') && lines[i].toLowerCase().includes('opus/48000')) {
      const match = lines[i].match(/a=rtpmap:(\d+)/);
      if (match) {
        opusPayloadType = match[1];
        break;
      }
    }
  }
  
  if (opusPayloadType) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
        // Enforce max bit rate and stereo on Opus fmtp parameter line
        lines[i] = `a=fmtp:${opusPayloadType} useinbandfec=1;stereo=1;maxaveragebitrate=128000;sprop-maxcapturerate=48000`;
        return lines.join('\r\n');
      }
    }
    // If line not present, add it
    lines.push(`a=fmtp:${opusPayloadType} useinbandfec=1;stereo=1;maxaveragebitrate=128000;sprop-maxcapturerate=48000`);
  }
  
  return lines.join('\r\n');
}

// Setup AudioContext
function setupAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}

// Setup Local Mic Visualizer
function setupLocalVisualizer() {
  const source = audioContext.createMediaStreamSource(localStream);
  localAnalyser = audioContext.createAnalyser();
  localAnalyser.fftSize = 256;
  source.connect(localAnalyser);
  
  renderLevelMeter('local-visualizer', localAnalyser, '#00b4d8');
}

// Setup Remote Peer Visualizer
function setupRemoteVisualizer(peerRole, stream) {
  setupAudioContext();
  
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  
  remoteAnalysers.set(peerRole, analyser);
  
  // Start canvas rendering after a slight delay to ensure element exists
  setTimeout(() => {
    renderLevelMeter(`visualizer-${peerRole}`, analyser, '#9b5de5');
  }, 100);
}

// Draw a studio-like DB meter on a canvas
function renderLevelMeter(canvasId, analyser, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  
  // Resize canvas according to device display resolution
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;
  
  // Stop existing animation loop if any
  if (activeVisualizers.has(canvasId)) {
    cancelAnimationFrame(activeVisualizers.get(canvasId));
  }
  
  function draw() {
    if (!document.getElementById(canvasId)) {
      activeVisualizers.delete(canvasId);
      return; // Element was removed from DOM
    }
    
    const loopRef = requestAnimationFrame(draw);
    activeVisualizers.set(canvasId, loopRef);
    
    analyser.getByteFrequencyData(dataArray);
    
    // Calculate average volume
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      sum += dataArray[i];
    }
    const average = sum / bufferLength;
    
    // Convert to normalized signal level (0 to 1)
    const level = average / 140; // Scale factor for visual feedback
    const fillWidth = Math.min(width, Math.floor(width * level));
    
    ctx.clearRect(0, 0, width, height);
    
    // Draw background grid ticks
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    for (let i = 0; i < width; i += width / 10) {
      ctx.fillRect(i, 0, 1, height);
    }
    
    // Draw filled meter with gradient
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#06d6a0'); // Safe green
    gradient.addColorStop(0.7, '#ffd166'); // Warning yellow
    gradient.addColorStop(1, '#ef476f'); // Clipping red
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, fillWidth, height);
    
    // Draw visual peak indicator line
    if (fillWidth > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(fillWidth - 2, 0, 2, height);
    }
  }
  
  draw();
}

// Create Card in UI for Remote Peer
function createPeerCard(peerRole) {
  // Check if card exists
  if (document.getElementById(`peer-card-${peerRole}`)) return;
  
  // Hide placeholder
  peersPlaceholder.classList.add('hidden');
  
  const roleLabels = {
    'host-1': 'Host 1 (Local Studio)',
    'host-2': 'Host 2 (Local Studio)',
    'host-3': 'Host 3 (Local Studio)',
    'guest': 'Remote Guest'
  };
  
  const card = document.createElement('div');
  card.id = `peer-card-${peerRole}`;
  card.className = 'meter-card fade-in';
  
  card.innerHTML = `
    <div class="meter-header">
      <h4>${roleLabels[peerRole] || peerRole}</h4>
      <div class="status-indicator">
        <span class="status-dot new" id="status-dot-${peerRole}"></span>
        <span id="status-label-${peerRole}" style="font-size:0.75rem;">Connecting</span>
      </div>
    </div>
    <div class="visualizer-container">
      <canvas id="visualizer-${peerRole}" class="level-canvas"></canvas>
      <div class="db-ticks">
        <span>-60</span><span>-40</span><span>-20</span><span>-10</span><span>0 dB</span>
      </div>
    </div>
  `;
  
  remotePeersGrid.appendChild(card);
}

// Remove Card from UI
function removePeerCard(peerRole) {
  const card = document.getElementById(`peer-card-${peerRole}`);
  if (card) {
    card.remove();
  }
  
  // Cancel active loop
  const canvasId = `visualizer-${peerRole}`;
  if (activeVisualizers.has(canvasId)) {
    cancelAnimationFrame(activeVisualizers.get(canvasId));
    activeVisualizers.delete(canvasId);
  }
  
  remoteAnalysers.delete(peerRole);
  
  // Show placeholder if no cards left
  if (remotePeersGrid.children.length === 0) {
    peersPlaceholder.classList.remove('hidden');
  }
}

// Clean up peer connection state
function cleanupPeerConnection(peerRole) {
  const pc = peerConnections.get(peerRole);
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.close();
    peerConnections.delete(peerRole);
  }
  
  // Stop remote audio element
  const audioEl = document.getElementById(`audio-${peerRole}`);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
  }
}

// Update active connection counts
function updatePeersCount() {
  const activeCount = peerConnections.size;
  diagPeers.textContent = activeCount;
  
  // Estimate relative WebRTC RTT stats (if supported by browser)
  if (activeCount > 0) {
    const firstPc = Array.from(peerConnections.values())[0];
    firstPc.getStats().then(stats => {
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime !== undefined) {
          const rttMs = Math.round(report.currentRoundTripTime * 1000);
          diagLatency.textContent = `${rttMs} ms`;
        }
      });
    });
  } else {
    diagLatency.textContent = '-';
  }
}

// Handle local Mute button click
let isMuted = false;
muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });
  
  if (isMuted) {
    muteBtn.classList.add('muted');
    muteBtn.innerHTML = '🔇';
    muteBtn.ariaLabel = 'Unmute microphone';
  } else {
    muteBtn.classList.remove('muted');
    muteBtn.innerHTML = '🎙️';
    muteBtn.ariaLabel = 'Mute microphone';
  }
});

// Leave / Disconnect session
function leaveSession() {
  // Clear WebRTC streams and connections
  peerConnections.forEach((pc, peerRole) => {
    cleanupPeerConnection(peerRole);
  });
  peerConnections.clear();
  
  // Clear visual loops
  activeVisualizers.forEach(loopRef => {
    cancelAnimationFrame(loopRef);
  });
  activeVisualizers.clear();
  
  // Stop local microphone
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Close socket
  if (ws) {
    ws.close();
    ws = null;
  }
  
  // Reset AudioContext
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  
  myRole = null;
  remoteAnalysers.clear();
  remotePeersGrid.innerHTML = '<p class="placeholder-text" id="peers-placeholder">Waiting for remote guest/hosts to connect...</p>';
  
  // Reset DOM UI
  dashboardScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  updateStatus('disconnected', 'Disconnected');
  diagSignaling.textContent = 'Offline';
  diagPeers.textContent = '0';
  diagLatency.textContent = '-';
}

leaveBtn.addEventListener('click', leaveSession);

// Initialize Device list on page load
window.addEventListener('DOMContentLoaded', initDevices);
