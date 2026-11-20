import React from 'react';

// Core game logic for Soulshift

// Initialize game state
let gameRunning = false;
let gameStarted = false;
let score = 0;
let highScore = localStorage.getItem('highScore') || 0;
let gameStartTime = 0;
let survivalTime = 0;

// Sound system with Web Audio API generated sounds
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const sounds = {};

// Generate simple sound effects
function generateSound(type, duration = 0.1, frequency = 440, volume = 0.5) {
    const sampleRate = audioContext.sampleRate;
    const buffer = audioContext.createBuffer(1, sampleRate * duration, sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        let value = 0;
        
        switch(type) {
            case 'hit':
                // Short click sound
                value = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-20 * t) * volume;
                break;
            case 'dash':
                // Whoosh sound
                value = Math.sin(2 * Math.PI * (800 - 600 * t) * t) * Math.exp(-4 * t) * volume;
                break;
            case 'explosion':
                // Low boom sound
                value = (Math.random() * 2 - 1) * Math.exp(-5 * t) * volume;
                break;
            case 'shoot':
                // Short beep
                value = Math.sin(2 * Math.PI * 660 * t) * Math.exp(-15 * t) * volume;
                break;
            case 'background':
                // Simple background drone
                value = (Math.sin(2 * Math.PI * 220 * t) * 0.3 + 
                        Math.sin(2 * Math.PI * 440 * t) * 0.2) * 
                        (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t)) * 
                        volume * 0.3;
                break;
            default:
                // Default case for unexpected types
                value = 0;
                break;
        }
        
        data[i] = value;
    }
    
    return buffer;
}

function App() {
    return (
        <div className="App">
            <h1>Soulshift Game</h1>
            <p>Game logic will be implemented here.</p>
        </div>
    );
}

export default App;

// Initialize all sounds
function initSounds() {
    sounds.hit = generateSound('hit', 0.1, 880, 0.7);
    sounds.dash = generateSound('dash', 0.3, 800, 0.5);
    sounds.explosion = generateSound('explosion', 0.5, 110, 0.6);
    sounds.shoot = generateSound('shoot', 0.15, 660, 0.4);
    sounds.background = generateSound('background', 4.0, 220, 0.3);
}

// Play sound function
function playSound(soundName, volume = 1.0, rate = 1.0) {
    if (!sounds[soundName]) return null;
    
    try {
        const source = audioContext.createBufferSource();
        const gainNode = audioContext.createGain();
        
        source.buffer = sounds[soundName];
        source.playbackRate.value = rate;
        gainNode.gain.value = Math.min(1, Math.max(0, volume));
        
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        source.start();
        
        // For background music, set it to loop
        if (soundName === 'background') {
            source.loop = true;
        }
        
        return source;
    } catch (e) {
        console.warn('Error playing sound:', e);
        return null;
    }
}

// Initialize canvas and context
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// Set canvas size
canvas.width = 800;
canvas.height = 600;

// Hide canvas initially, show start menu
canvas.style.display = 'none';

// Set up event listeners
document.addEventListener('keydown', (e) => {
    if (!gameStarted && document.getElementById('start-menu').style.display !== 'none') {
        initGame();
    }
});

// Player properties
const player = {
    x: 100,
    y: 300,
    width: 24,  // 0.75 of 32
    height: 24, // 0.75 of 32
    speed: 5,
    maxHits: 8,
    hitsRemaining: 8,
    isMoving: false,
    direction: { x: 0, y: 0 },
    // Dash properties
    isDashing: false,
    dashSpeed: 15,
    dashDuration: 10,
    dashCooldown: 0,
    dashCooldownMax: 30,
    dashDirection: { x: 0, y: 0 },
    // Immunity properties
    isImmune: false,
    immunityTimer: 0,
    immunityDuration: 120, // 2 seconds at 60fps
    flashTimer: 0,
    flashRate: 5,
    isVisible: true,
    healTimer: 0,
    healInterval: 20 * 60 // 20 seconds at 60 FPS
};

// Keyboard input
const keys = {
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false,
    w: false,
    a: false,
    s: false,
    d: false,
};

// Event listeners for keyboard input
document.addEventListener('keydown', (e) => {
    if (e.key in keys) {
        keys[e.key] = true;
        player.isMoving = true;
    }
    // Dash on Space key
    if (e.key === ' ' && !player.isDashing && player.dashCooldown <= 0) {
        player.isDashing = true;
        player.dashCooldown = player.dashCooldownMax;
        // Store dash direction based on current movement
        player.dashDirection = { ...player.direction };
        // If not moving, dash in the direction the player is facing (right by default)
        if (player.dashDirection.x === 0 && player.dashDirection.y === 0) {
            player.dashDirection.x = 1;
        }
        
        // Play dash sound
        playSound('dash', 0.5, 1.0 + Math.random() * 0.2);
    }
});

document.addEventListener('keyup', (e) => {
    if (e.key in keys) {
        keys[e.key] = false;
        player.isMoving = false;
    }
});

// Update player movement
function updatePlayer() {
    // Reset direction
    player.direction = { x: 0, y: 0 };
    
    // Get movement input
    if (keys.ArrowUp || keys.w) player.direction.y = -1;
    if (keys.ArrowDown || keys.s) player.direction.y = 1;
    if (keys.ArrowLeft || keys.a) player.direction.x = -1;
    if (keys.ArrowRight || keys.d) player.direction.x = 1;

    // Handle dashing
    if (player.isDashing) {
        // Move in dash direction at dash speed
        player.x += player.dashDirection.x * player.dashSpeed;
        player.y += player.dashDirection.y * player.dashSpeed;
        
        // Decrease dash duration
        player.dashDuration--;
        if (player.dashDuration <= 0) {
            player.isDashing = false;
            player.dashDuration = 10; // Reset dash duration
        }
    } else {
        // Normal movement
        // Normalize diagonal movement
        if (player.direction.x !== 0 && player.direction.y !== 0) {
            player.direction.x *= 0.7;
            player.direction.y *= 0.7;
        }
        
        // Apply movement
        player.x += player.direction.x * player.speed;
        player.y += player.direction.y * player.speed;
    }
    
    // Update dash cooldown and immunity
    if (player.dashCooldown > 0) {
        player.dashCooldown--;
    }
    
    // Update immunity timer
    if (player.immunityTimer > 0) {
        player.immunityTimer--;
        player.flashTimer = (player.flashTimer + 1) % (player.flashRate * 2);
        player.isVisible = player.flashTimer < player.flashRate;
        
        if (player.immunityTimer <= 0) {
            player.isImmune = false;
            player.isVisible = true;
        }
    }

    // Passive regeneration
    player.healTimer++;

    if (
        player.healTimer >= player.healInterval &&
        player.hitsRemaining < player.maxHits
    ) {
        player.healTimer = 0;
        player.hitsRemaining++;

        playSound('heal', 0.5, 1.2);
    }

    // Boundary checks
    player.x = Math.max(0, Math.min(canvas.width - player.width, player.x));
    player.y = Math.max(0, Math.min(canvas.height - player.height, player.y));
}

// Bullet Hell Pattern Properties
const bulletHell = {
    spawnTimer: 0,
    spawnRate: 10, // Faster spawn rate
    projectiles: [],
    lasers: [],
    sniperWarnings: [],
    bombs: [], // Add bombs array
    patterns: [
        // Basic patterns (available from start)
        { type: 'circle', speed: 1.0, amount: 8, cooldown: 200, minTime: 0, lastUsed: -9999 },
        { type: 'spread', speed: 1.5, amount: 5, spread: 60, cooldown: 150, minTime: 0, lastUsed: -9999 },
        
        // Unlock after 30 seconds
        { type: 'spiral', speed: 0.7, amount: 16, cooldown: 240, minTime: 30, lastUsed: -9999 },
        { type: 'laser', cooldown: 220, groupSize: 1, minTime: 45, lastUsed: -9999 },
        
        // Mid-game patterns unlock between 100 and 120 seconds
        { type: 'doubleSpiral', speed: 0.6, amount: 12, cooldown: 320, minTime: 120, lastUsed: -9999 },
        { type: 'shotgun', speed: 1.0, amount: 5, spread: 65, cooldown: 260, minTime: 100, lastUsed: -9999 },
        
        // Unlock after 120 seconds
        { type: 'cross', speed: 1.2, amount: 4, cooldown: 220, minTime: 120, lastUsed: -9999 },
        { type: 'wave', speed: 1.0, amount: 12, cooldown: 280, minTime: 150, lastUsed: -9999 },
        
        // Unlock after 180 seconds
        { type: 'homing', speed: 0.8, amount: 4, cooldown: 320, minTime: 180, lastUsed: -9999 },
        { type: 'pulse', speed: 1.0, amount: 8, cooldown: 300, minTime: 210, lastUsed: -9999 },
        
        // Unlock after 180 seconds
        { type: 'bomb', speed: 2.0, amount: 1, cooldown: 350, minTime: 180, lastUsed: -9999, size: 30, damage: 1 },
        
        // Sniper unlocks before the final pattern set
        { type: 'sniper', speed: 24, amount: 1, cooldown: 420, warningTime: 90, minTime: 150, lastUsed: -9999 },
        { type: 'laser', cooldown: 220, groupSize: 2, minTime: 240, lastUsed: -9999 },
        
        // Big bullet unlocks at 120 seconds
        { type: 'bigbullet', speed: 1.5, amount: 1, cooldown: 400, minTime: 120, lastUsed: -9999, size: 80, damage: 1 },
        
        // Rotating distraction bullets unlock after 120 seconds
        { type: 'rotating', amount: 4, cooldown: 360, minTime: 120, lastUsed: -9999, orbitRadius: 120, orbitSpeed: 0.05 },
    ],
    lastPatternTime: 0,
    minTimeBetweenPatterns: 60,
    gameTime: 0,
    difficulty: 1.0
};

// Player hit handling
function takeHit() {
    if (!player.isImmune && player.hitsRemaining > 0) {
        player.hitsRemaining--;
        player.isImmune = true;
        player.immunityTimer = player.immunityDuration;
        
        // Play hit sound
        playSound('hit', 0.7, 1.0 + Math.random() * 0.2);
        
        // Game over check
        checkGameOver();
    }
}

// Minions
const minions = [];

// Projectiles
let projectiles = [];

// Create bullet pattern
function createBulletPattern(pattern, x, y) {
    const bullets = [];
    const angleIncrement = (Math.PI * 2) / (pattern.amount || 1);
    
    // Debug log pattern spawn
    console.log(`[DEBUG] Spawning pattern: ${pattern.type}`, {
        x: x.toFixed(0),
        y: y.toFixed(0),
        amount: pattern.amount,
        speed: pattern.speed,
        cooldown: pattern.cooldown,
        minTime: pattern.minTime
    });
    
    switch (pattern.type) {
        case 'sniper': {
            const targetX = player.x + player.width / 2;
            const targetY = player.y + player.height / 2;
            bulletHell.sniperWarnings.push({
                x,
                y,
                angle: Math.atan2(targetY - y, targetX - x),
                timer: 0,
                warningTime: pattern.warningTime || 90,
                shotSpeed: pattern.speed || 24
            });
            break;
        }
        default:
            // Handle unexpected pattern types
            break;
        case 'circle':
            for (let i = 0; i < pattern.amount; i++) {
                const angle = angleIncrement * i;
                const speed = pattern.speed * (0.8 + Math.random() * 0.4); // Random speed variation
                bullets.push({
                    x,
                    y,
                    width: 6,
                    height: 6,
                    speed: speed,
                    baseSpeed: speed, // Store base speed for acceleration
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    color: `hsl(${Math.random() * 60 + 180}, 100%, 60%)`,
                    acceleration: 1.01 // Slower acceleration for all bullets
                });
            }
            break;
            
        case 'spiral':
            const offset = Date.now() * 0.002; // Faster spiral
            for (let i = 0; i < pattern.amount; i++) {
                const angle = (angleIncrement * i * 1.5) + offset;
                const speed = pattern.speed * (0.8 + Math.random() * 0.4);
                bullets.push({
                    x,
                    y,
                    width: 5,
                    height: 5,
                    speed: speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    color: `hsl(${(i * 10) % 360}, 100%, 65%)`,
                    acceleration: 1.01
                });
            }
            break;
            
        case 'doubleSpiral':
            const spiralOffset = Date.now() * 0.003; // Faster double spiral
            for (let i = 0; i < pattern.amount; i++) {
                const angle1 = (angleIncrement * i * 1.2) + spiralOffset;
                const angle2 = (angleIncrement * i * 1.2) - spiralOffset;
                const speed1 = pattern.speed * (0.85 + Math.random() * 0.3);
                const speed2 = pattern.speed * (0.85 + Math.random() * 0.3);
                
                // First spiral
                bullets.push({
                    x,
                    y,
                    width: 4,
                    height: 4,
                    speed: speed1,
                    baseSpeed: speed1,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle1) * speed1,
                    vy: Math.sin(angle1) * speed1,
                    color: 'hsl(180, 100%, 60%)',
                    acceleration: 1.005
                });
                
                // Second spiral (rotated 180 degrees)
                bullets.push({
                    x,
                    y,
                    width: 4,
                    height: 4,
                    speed: speed2,
                    baseSpeed: speed2,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle2 + Math.PI) * speed2,
                    vy: Math.sin(angle2 + Math.PI) * speed2,
                    color: 'hsl(330, 100%, 65%)',
                    acceleration: 1.005
                });
            }
            break;
            
        case 'spread':
            const startAngle = -pattern.spread * (Math.PI / 180) / 2;
            const angleStep = pattern.spread * (Math.PI / 180) / (pattern.amount - 1);
            
            for (let i = 0; i < pattern.amount; i++) {
                const angle = startAngle + (angleStep * i);
                const speed = pattern.speed * (0.9 + Math.random() * 0.2);
                bullets.push({
                    x,
                    y,
                    width: 6,
                    height: 6,
                    speed: speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    color: `hsl(${30 + (i * 10) % 60}, 100%, 60%)`,
                    acceleration: 1.01
                });
            }
            break;
            
        case 'laser':
            // Create a group of lasers (default to 1 if not specified)
            const groupSize = pattern.groupSize || 1;
            // const minDistance = 100; // Unused variable
            
            for (let g = 0; g < groupSize; g++) {
                // Create a warning laser first (red outline)
                const laser = {
                    x: canvas.width / 2 + (Math.random() - 0.5) * 200, // Offset position randomly
                    y: canvas.height / 2 + (Math.random() - 0.5) * 200, // Offset position randomly
                    width: canvas.width * 1.5, // Make lasers longer (150% of canvas width)
                    height: 45, // 45 pixels thick
                    isWarning: true,
                    warningTime: 60, // 1 second warning at 60fps
                    activeTime: 30,  // 0.5 seconds active
                    timer: 0,
                    damage: 2, // 2/5 damage as requested
                    isPlayerProjectile: false,
                    angle: Math.random() * Math.PI * 2, // Any angle, 0 to 2π radians
                    trails: [],
                    trailLifetime: 80
                };
                
                // For multiple lasers, space them out by angle
                if (groupSize > 1) {
                    laser.angle = (Math.PI * 2 * g) / groupSize;
                }
                
                bulletHell.lasers.push(laser);
            }
            break;
            
        case 'bomb':
            // Launch bomb from random edge
            const edge = Math.floor(Math.random() * 4);
            let bombX, bombY, bombVx, bombVy;
            
            switch(edge) {
            default:
                // Handle unexpected edge cases
                break;
                case 0: // Top
                    bombX = Math.random() * canvas.width;
                    bombY = -20;
                    bombVx = (Math.random() - 0.5) * 2;
                    bombVy = pattern.speed * 0.5;
                    break;
                case 1: // Right
                    bombX = canvas.width + 20;
                    bombY = Math.random() * canvas.height;
                    bombVx = -pattern.speed * 0.5;
                    bombVy = (Math.random() - 0.5) * 2;
                    break;
                case 2: // Bottom
                    bombX = Math.random() * canvas.width;
                    bombY = canvas.height + 20;
                    bombVx = (Math.random() - 0.5) * 2;
                    bombVy = -pattern.speed * 0.5;
                    break;
                case 3: // Left
                    bombX = -20;
                    bombY = Math.random() * canvas.height;
                    bombVx = pattern.speed * 0.5;
                    bombVy = (Math.random() - 0.5) * 2;
                    break;
            }
            
            bullets.push({
                x: bombX,
                y: bombY,
                width: pattern.size,
                height: pattern.size,
                speed: pattern.speed,
                vx: bombVx,
                vy: bombVy,
                damage: pattern.damage,
                type: 'bomb',
                isPlayerProjectile: false,
                color: '#ff0000',
                lifetime: 120, // 2 seconds at 60fps
                explosionRadius: 100,
                flashTimer: 0,
                flashInterval: 10, // Start flashing faster as it gets closer to exploding
                originalColor: '#ff0000',
                explosionParticles: [],
                hasExploded: false
            });
            break;
            
        case 'pulse':
            const pulseSize = 1.0 + Math.sin(Date.now() * 0.01) * 0.5;
            for (let i = 0; i < pattern.amount; i++) {
                const angle = (Math.PI * 2 * i) / pattern.amount;
                bullets.push({
                    x,
                    y,
                    width: 8 * pulseSize,
                    height: 8 * pulseSize,
                    speed: pattern.speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * pattern.speed,
                    vy: Math.sin(angle) * pattern.speed,
                    color: `hsl(${Date.now() * 0.1 % 360}, 100%, 60%)`,
                    pulse: true,
                    baseSize: 8
                });
            }
            break;
            
        case 'cross':
            // Cross pattern (4 directions) - spawns from center or random positions and aims at player
            const spawnFromCenter = Math.random() < 0.7; // 70% chance to spawn from center
            let spawnX, spawnY;
            
            if (spawnFromCenter) {
                spawnX = canvas.width / 2;
                spawnY = canvas.height / 2;
            } else {
                // Spawn from random position, but not too close to edges
                const margin = 150;
                spawnX = margin + Math.random() * (canvas.width - 2 * margin);
                spawnY = margin + Math.random() * (canvas.height - 2 * margin);
            }
            
            // Calculate angle to player
            const angleToPlayer = Math.atan2(
                (player.y + player.height/2) - spawnY,
                (player.x + player.width/2) - spawnX
            );
            
            // Create 4 directions (cross) rotated to face player
            for (let i = 0; i < 4; i++) {
                const angle = angleToPlayer + (i * Math.PI / 2);
                const speed = pattern.speed * (0.9 + Math.random() * 0.2);
                
                bullets.push({
                    x: spawnX,
                    y: spawnY,
                    width: 6,
                    height: 6,
                    speed: speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    color: '#ff4444',
                    acceleration: 1.02
                });
            }
            break;
            
        case 'wave':
            // Enhanced wave pattern with more natural and varied movement
            // const waveCount = 3; // Unused variable
            const baseSpeed = pattern.speed * 0.8;
            
            for (let i = 0; i < pattern.amount; i++) {
                // Calculate base angle with slight offset for natural spread
                const angleOffset = (Math.random() - 0.5) * 0.2; // Small random angle offset
                const baseAngle = (i / pattern.amount) * Math.PI * 2 + angleOffset;
                
                // Vary speed slightly for more organic movement
                const speed = baseSpeed * (0.9 + Math.random() * 0.2);
                
                // Create unique wave properties for each bullet
                const waveProps = {
                    offset: Math.random() * Math.PI * 2, // Random starting point in wave cycle
                    frequency: 0.08 + Math.random() * 0.05, // Increased frequency for more waves
                    amplitude: 3.0 + Math.random() * 2.0,   // Increased amplitude for more visible waves
                    baseAngle: baseAngle,
                    time: 0,
                    speedVariation: 0.02 + Math.random() * 0.03, // More speed variation
                    phaseShift: Math.random() * Math.PI * 2,    // Random phase shift
                    waveOffset: Math.random() * 100,            // Random wave offset
                    waveScale: 0.5 + Math.random() * 0.5        // Scale factor for wave effect
                };
                
                bullets.push({
                    x,
                    y,
                    width: 5 + Math.random() * 2, // Slightly varied size
                    height: 5 + Math.random() * 2,
                    speed: speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: 0, // Will be set by update function
                    vy: 0, // Will be set by update function
                    color: `hsl(${(i * 360 / pattern.amount + Date.now() * 0.01) % 360}, 100%, 60%)`,
                    wave: waveProps,
                    update: function() {
                        // Update wave properties with smooth time-based changes
                        this.wave.time += 0.03;
                        
                        // Calculate wave offset with multiple frequencies for more complex motion
                        const wave1 = Math.sin(this.wave.time * this.wave.frequency + this.wave.phaseShift);
                        const wave2 = Math.sin(this.wave.time * this.wave.frequency * 1.5 + this.wave.phaseShift * 0.8);
                        const wave3 = Math.sin(this.wave.time * this.wave.frequency * 0.7 + this.wave.phaseShift * 1.3);
                        
                        // Combine waves for more organic motion
                        const combinedWave = (wave1 * 0.6 + wave2 * 0.3 + wave3 * 0.1);
                        
                        // Calculate perpendicular offset for wave motion
                        const perpAngle = this.wave.baseAngle + Math.PI/2; // 90 degrees from movement direction
                        const waveStrength = combinedWave * this.wave.amplitude * this.wave.waveScale;
                        
                        // Calculate base movement direction
                        const baseVx = Math.cos(this.wave.baseAngle) * this.speed;
                        const baseVy = Math.sin(this.wave.baseAngle) * this.speed;
                        
                        // Add wave motion perpendicular to the base direction
                        const waveVx = Math.cos(perpAngle) * waveStrength;
                        const waveVy = Math.sin(perpAngle) * waveStrength;
                        
                        // Update velocity with wave motion
                        this.vx = baseVx + waveVx;
                        this.vy = baseVy + waveVy;
                        
                        // Update position
                        this.x += this.vx;
                        this.y += this.vy;
                        
                        // Add subtle rotation based on wave motion, not direction
                        this.rotation = Math.sin(this.wave.time * 2) * 0.2;
                    }
                });
            }
            break;
            
        case 'homing':
            // Homing bullets
            for (let i = 0; i < pattern.amount; i++) {
                const angle = (Math.PI * 2 * i) / pattern.amount;
                const speed = pattern.speed * (0.9 + Math.random() * 0.2);
                bullets.push({
                    x,
                    y,
                    width: 7,
                    height: 7,
                    speed: speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    color: '#ff9900',
                    homing: true,
                    homingStrength: 0.05,
                    maxHomingSpeed: 3.0,
                    acceleration: 1.01
                });
            }
            break;
            
        case 'shotgun':
            // Uncontrolled bullet spray
            const baseAngle = Math.atan2(
                player.y + player.height/2 - y,
                player.x + player.width/2 - x
            );
            
            for (let i = 0; i < pattern.amount; i++) {
                const spread = (Math.random() - 0.5) * (pattern.spread * Math.PI / 180);
                const angle = baseAngle + spread;
                const speed = pattern.speed * (0.7 + Math.random() * 0.6);
                bullets.push({
                    x,
                    y,
                    width: 5,
                    height: 5,
                    speed: speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    color: '#ff6666',
                    acceleration: 1.02
                });
            }
            break;
            
        case 'bigbullet':
            // Spawn from random position towards player or in random direction
            const angle = Math.atan2(
                player.y + player.height/2 - y,
                player.x + player.width/2 - x
            ) + (Math.random() - 0.5) * 0.4; // Slight randomness in direction
            const speed = pattern.speed * (0.8 + Math.random() * 0.4);
            
            bullets.push({
                x,
                y,
                width: pattern.size,
                height: pattern.size,
                speed: speed,
                baseSpeed: speed,
                damage: 1,
                isPlayerProjectile: false,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                color: '#FF00FF',
                acceleration: 1.005,
                isBigBullet: true
            });
            break;
            
        case 'rotating':
            // Rotating bullets that enter from offscreen and then orbit the player
            for (let i = 0; i < pattern.amount; i++) {
                const orbitRadius = pattern.orbitRadius + (Math.random() - 0.5) * 40; // Vary radius slightly
                const orbitSpeed = pattern.orbitSpeed * (0.8 + Math.random() * 0.4); // Vary speed
                const spawnEdge = Math.floor(Math.random() * 4);
                let bulletX = 0;
                let bulletY = 0;

                switch (spawnEdge) {
                    case 0: // Top
                        bulletX = Math.random() * canvas.width;
                        bulletY = -30;
                        break;
                    case 1: // Right
                        bulletX = canvas.width + 30;
                        bulletY = Math.random() * canvas.height;
                        break;
                    case 2: // Bottom
                        bulletX = Math.random() * canvas.width;
                        bulletY = canvas.height + 30;
                        break;
                    case 3: // Left
                        bulletX = -30;
                        bulletY = Math.random() * canvas.height;
                        break;
                }

                const entryAngle = Math.atan2(
                    (player.y + player.height/2) - bulletY,
                    (player.x + player.width/2) - bulletX
                );
                const orbitAngle = entryAngle + (Math.random() - 0.5) * 0.5; // Slight offset for orbit direction

                bullets.push({
                    x: bulletX,
                    y: bulletY,
                    width: 9,
                    height: 9,
                    damage: 1,
                    isPlayerProjectile: false,
                    color: `hsl(${Math.random() * 360}, 100%, 60%)`,
                    isDistraction: true,
                    rotating: true,
                    state: 'entering',
                    entryAngle: entryAngle,
                    entrySpeed: 4 + Math.random() * 1.5,
                    orbitCenterX: player.x + player.width/2,
                    orbitCenterY: player.y + player.height/2,
                    orbitRadius: orbitRadius,
                    orbitAngle: orbitAngle,
                    orbitSpeed: orbitSpeed,
                    colorChangeSpeed: 0.02 + Math.random() * 0.03, // Random color change speed
                    colorHue: Math.random() * 360
                });
            }
            break;
    }
    
    return bullets;
}

// Update bullet hell system
function updateBulletHell() {
    bulletHell.gameTime += 1;
    const gameTimeInSeconds = bulletHell.gameTime / 60;
    bulletHell.difficulty = 1.0 + Math.min(gameTimeInSeconds / 240, 1.0);
    
    // Update pattern cooldowns and select available patterns
    let availablePatterns = [];
    const basePatterns = [];
    
    // Check which patterns are available and ready
    for (const pattern of bulletHell.patterns) {
        // Skip patterns that haven't unlocked yet
        if (gameTimeInSeconds < pattern.minTime) continue;
        
        // Check if pattern is off cooldown
        const framesSinceLastUse = bulletHell.gameTime - (pattern.lastUsed || 0);
        let cooldown = pattern.cooldown / (1 + (bulletHell.difficulty - 1) * 0.3);
        
        // Make early patterns appear more frequently
        if (pattern.minTime < 60) { // First minute patterns
            cooldown *= 0.8;
        }
        
        if (framesSinceLastUse >= cooldown) {
            // Add some patterns to base patterns for more frequent selection
            if (pattern.minTime < 60 || Math.random() > 0.3) {
                basePatterns.push(pattern);
            }
            availablePatterns.push(pattern);
        }
    }
    
    // If we have base patterns, use them 60% of the time for more frequent attacks
    if (basePatterns.length > 0 && Math.random() > 0.4) {
        availablePatterns = basePatterns;
    }
    
    // If we have available patterns and enough time has passed since last pattern
    const minTime = Math.max(60, bulletHell.minTimeBetweenPatterns * (1.5 - (bulletHell.difficulty - 1) * 0.3));
    
    if (availablePatterns.length > 0 && 
        (bulletHell.gameTime - bulletHell.lastPatternTime) >= minTime) {
        
        // Select random pattern from available ones
        const patternIndex = Math.floor(Math.random() * availablePatterns.length);
        const pattern = availablePatterns[patternIndex];
        
        // Mark pattern as used
        pattern.lastUsed = bulletHell.gameTime;
        bulletHell.lastPatternTime = bulletHell.gameTime;
        
        // Randomly choose spawn position (edge or center)
        let x, y;
        const spawnFromCenter = Math.random() < 0.3 && 
            ['circle', 'spread', 'wave', 'spiral'].includes(pattern.type);
            
        if (spawnFromCenter) {
            // Spawn from center of the screen
            x = canvas.width / 2;
            y = canvas.height / 2;
        } else {
            // Spawn from edge (original behavior)
            const edge = Math.floor(Math.random() * 4);
            switch (edge) {
            default:
                // Handle unexpected edge cases
                break;
                case 0: // Top
                    x = Math.random() * canvas.width;
                    y = -20;
                    break;
                case 1: // Right
                    x = canvas.width + 20;
                    y = Math.random() * canvas.height;
                    break;
                case 2: // Bottom
                    x = Math.random() * canvas.width;
                    y = canvas.height + 20;
                    break;
                case 3: // Left
                    x = -20;
                    y = Math.random() * canvas.height;
                    break;
            }
        }
        
        const scaledPattern = {
            ...pattern,
            amount: Math.min(
                Math.ceil(pattern.amount * (1 + (bulletHell.difficulty - 1) * 0.2)),
                pattern.type === 'doubleSpiral' ? 14 : 18
            ),
            speed: pattern.speed * (1 + (bulletHell.difficulty - 1) * 0.08),
            cooldown: pattern.cooldown * (1 - (bulletHell.difficulty - 1) * 0.05)
        };
        
        const patternBullets = createBulletPattern(scaledPattern, x, y);
        projectiles.push(...patternBullets);
    }
    
    for (let i = bulletHell.sniperWarnings.length - 1; i >= 0; i--) {
        const warning = bulletHell.sniperWarnings[i];
        warning.timer += 1;
        warning.angle = Math.atan2(
            player.y + player.height / 2 - warning.y,
            player.x + player.width / 2 - warning.x
        );

        if (warning.timer >= warning.warningTime) {
            projectiles.push({
                x: warning.x,
                y: warning.y,
                width: 18,
                height: 8,
                speed: warning.shotSpeed,
                vx: Math.cos(warning.angle) * warning.shotSpeed,
                vy: Math.sin(warning.angle) * warning.shotSpeed,
                damage: 2,
                isPlayerProjectile: false,
                isSniperShot: true,
                color: '#fff0a6'
            });
            bulletHell.sniperWarnings.splice(i, 1);
        }
    }

    // Update lasers
    for (let i = bulletHell.lasers.length - 1; i >= 0; i--) {
        const laser = bulletHell.lasers[i];
        laser.timer++;
        
        // Check if laser should become active
        if (laser.isWarning && laser.timer >= laser.warningTime) {
            laser.isWarning = false;
            laser.timer = 0;
        }
        // Check if laser should be removed
        else if (!laser.isWarning && laser.timer >= laser.activeTime) {
            bulletHell.lasers.splice(i, 1);
            continue;
        }
        
        // Check collision with player when active
        if (!laser.isWarning && !player.isDashing && !player.isImmune) {
            // Check if player center is within the laser beam (rotated rectangle)
            const playerCenterX = player.x + player.width / 2;
            const playerCenterY = player.y + player.height / 2;
            
            // Translate player position to laser's local coordinate system
            const dx = playerCenterX - laser.x;
            const dy = playerCenterY - laser.y;
            const cos = Math.cos(-laser.angle);
            const sin = Math.sin(-laser.angle);
            const localX = dx * cos - dy * sin;
            const localY = dx * sin + dy * cos;
            
            // Check if point is within the rotated rectangle
            // Rectangle is centered at origin, extends from -height/2 to +height/2 vertically
            // and from -width/2 to +width/2 horizontally
            const halfWidth = laser.width / 2;
            const halfHeight = laser.height / 2;
            
            if (Math.abs(localX) < halfWidth && Math.abs(localY) < halfHeight) {
                takeHit();
                // Give brief invulnerability after hit
                player.isImmune = true;
                player.immunityTimer = Math.max(player.immunityTimer, 30); // 0.5s invuln
            }
        }

        // Build a separate lasting red trail for active lasers
        if (!laser.isWarning) {
            laser.trails.push({
                x: laser.x,
                y: laser.y,
                width: laser.width,
                height: laser.height,
                angle: laser.angle,
                life: laser.trailLifetime
            });
        }

        if (laser.trails && laser.trails.length > 0) {
            for (let t = laser.trails.length - 1; t >= 0; t--) {
                laser.trails[t].life--;
                if (laser.trails[t].life <= 0) {
                    laser.trails.splice(t, 1);
                }
            }
        }
    }
}

// Update projectiles
function updateProjectiles() {
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        
        // Big bullet collision with other bullets
        if (p.isBigBullet) {
            // Destroy overlapping bullets
            for (let j = projectiles.length - 1; j >= 0; j--) {
                if (j === i) continue; // Skip self
                
                const other = projectiles[j];
                if (other.isBigBullet) continue; // Don't collide with other big bullets
                
                // Check collision
                const dist = Math.sqrt(
                    Math.pow(p.x + p.width/2 - (other.x + other.width/2), 2) +
                    Math.pow(p.y + p.height/2 - (other.y + other.height/2), 2)
                );
                
                if (dist < (p.width + other.width) / 2) {
                    // Destroy the other bullet
                    projectiles.splice(j, 1);
                    if (j < i) i--; // Adjust index if we removed from below
                }
            }
            
            // Big bullet damages player
            if (!p.isPlayerProjectile &&
                p.x < player.x + player.width && p.x + p.width > player.x &&
                p.y < player.y + player.height && p.y + p.height > player.y) {
                if (!player.isDashing && !player.isImmune) {
                    takeHit();
                }
                projectiles.splice(i, 1);
                continue;
            }
        }
        
        // Update rotating projectiles
        else if (p.rotating) {
            // Update orbit center to follow player
            p.orbitCenterX = player.x + player.width/2;
            p.orbitCenterY = player.y + player.height/2;
            
            // Update color
            p.colorHue = (p.colorHue + p.colorChangeSpeed) % 360;
            p.color = `hsl(${p.colorHue}, 100%, 60%)`;

            if (p.state === 'entering') {
                p.x += Math.cos(p.entryAngle) * p.entrySpeed;
                p.y += Math.sin(p.entryAngle) * p.entrySpeed;

                const distToCenter = Math.sqrt(
                    Math.pow(p.x - p.orbitCenterX, 2) +
                    Math.pow(p.y - p.orbitCenterY, 2)
                );

                if (distToCenter <= p.orbitRadius) {
                    p.state = 'orbiting';
                    p.orbitAngle = Math.atan2(p.y - p.orbitCenterY, p.x - p.orbitCenterX);
                }
            } else {
                p.orbitAngle += p.orbitSpeed;
                p.x = p.orbitCenterX + Math.cos(p.orbitAngle) * p.orbitRadius;
                p.y = p.orbitCenterY + Math.sin(p.orbitAngle) * p.orbitRadius;

                // Remove orbiting bullets once they hit the visible edge
                if (p.state === 'orbiting' &&
                    (p.x < -p.width || p.x > canvas.width + p.width ||
                     p.y < -p.height || p.y > canvas.height + p.height)) {
                    projectiles.splice(i, 1);
                    continue;
                }
            }

            // Skip normal projectile motion for rotating bullets
            continue;
        }
        
        // Update bomb projectiles
        if (p.type === 'bomb') {
            // Slow down the bomb
            p.speed = Math.max(0.5, p.speed * 0.99);
            p.vx *= 0.99;
            p.vy *= 0.99;
            
            // Make bomb flash faster as it gets closer to exploding
            p.flashTimer++;
            if (p.flashTimer >= p.flashInterval) {
                p.flashTimer = 0;
                p.color = p.color === p.originalColor ? '#ffffff' : p.originalColor;
                
                // Increase flash frequency in last second
                if (p.lifetime < 60) {
                    p.flashInterval = 5;
                }
            }
            
            // Handle bomb lifetime
            p.lifetime--;
            
            if (p.lifetime <= 0 && !p.hasExploded) {
                p.hasExploded = true;
                
                // Single ring of 8 bullets for explosion
                const explosionPatterns = [
                    { type: 'circle', amount: 8, speed: 3.0, size: 8, color: '#ff5555' }
                ];
                
                // Add slight delay between rings for better visual effect
                explosionPatterns.forEach((pattern, index) => {
                    const explosionX = p.x + p.width/2;
                    const explosionY = p.y + p.height/2;
                    
                    setTimeout(() => {
                        const bullets = createBulletPattern({
                            ...pattern,
                            damage: 1
                        }, explosionX, explosionY);
                        
                        if (bullets && bullets.length > 0) {
                            // Add acceleration to explosion bullets
                            bullets.forEach(bullet => {
                                bullet.acceleration = 1.01;
                                bullet.lifetime = 180; // 3 seconds max lifetime
                                bullet.fadeTime = 150; // Start fading after 2.5 seconds
                            });
                            
                            // Use a helper function to safely add bullets
                            addBulletsToProjectiles(bullets);
                        }
                    }, index * 2); // Small delay between rings
                });
                
                function addBulletsToProjectiles(newBullets) {
                    projectiles.push(...newBullets);
                }
                
                // Add special bullet patterns from the explosion
                const patternTypes = ['circle', 'spread', 'wave', 'spiral'];
                const pattern = patternTypes[Math.floor(Math.random() * patternTypes.length)];
                
                switch (pattern) {
                default:
                    // Handle unexpected pattern cases
                    break;
                    case 'circle':
                        // Circle pattern from explosion center
                        for (let i = 0; i < 24; i++) {
                            const angle = (i / 24) * Math.PI * 2;
                            const speed = 3.0 * (0.8 + Math.random() * 0.4);
                            
                            bulletHell.projectiles.push({
                                x: p.x + p.width/2,
                                y: p.y + p.height/2,
                                width: 6,
                                height: 6,
                                speed: speed,
                                vx: Math.cos(angle) * speed,
                                vy: Math.sin(angle) * speed,
                                damage: 1,
                                isPlayerProjectile: false,
                                color: `hsl(${Math.random() * 60 + 180}, 100%, 60%)`,
                                acceleration: 1.01
                            });
                        }
                        break;
                        
                    case 'spread':
                        // Spread pattern from explosion center
                        const spreadCount = 16;
                        const spreadAngle = Math.PI * 0.7; // 126 degree spread
                        const startAngle = -spreadAngle / 2;
                        
                        for (let i = 0; i < spreadCount; i++) {
                            const angle = startAngle + (i / (spreadCount - 1)) * spreadAngle;
                            const speed = 4.0 * (0.8 + Math.random() * 0.4);
                            
                            bulletHell.projectiles.push({
                                x: p.x + p.width/2,
                                y: p.y + p.height/2,
                                width: 5,
                                height: 5,
                                speed: speed,
                                vx: Math.cos(angle) * speed,
                                vy: Math.sin(angle) * speed,
                                damage: 1,
                                isPlayerProjectile: false,
                                color: `hsl(${30 + (i * 10) % 60}, 100%, 60%)`,
                                acceleration: 1.02
                            });
                        }
                        break;
                        
                    case 'wave':
                        // Wave pattern from explosion center
                        const waveOffset = Date.now() * 0.003;
                        const waveCount = 24;
                        
                        for (let i = 0; i < waveCount; i++) {
                            const angle = (i / waveCount) * Math.PI * 2;
                            const wave = Math.sin(i * 0.5 + waveOffset) * 0.5;
                            const speed = 2.5 * (0.8 + Math.random() * 0.4);
                            
                            bulletHell.projectiles.push({
                                x: p.x + p.width/2,
                                y: p.y + p.height/2,
                                width: 5,
                                height: 5,
                                speed: speed,
                                vx: Math.cos(angle + wave) * speed,
                                vy: Math.sin(angle + wave) * speed,
                                damage: 1,
                                isPlayerProjectile: false,
                                color: `hsl(${(i * 15) % 360}, 100%, 60%)`,
                                acceleration: 1.015
                            });
                        }
                        break;
                        
                    case 'spiral':
                        // Spiral pattern from explosion center
                        const spiralCount = 36;
                        // const spiralSpeed = 0.1; // Unused variable
                        
                        for (let i = 0; i < spiralCount; i++) {
                            const angle = (i / spiralCount) * Math.PI * 2 + (Date.now() * 0.005);
                            const radius = (i / spiralCount) * 5;
                            const speed = 2.5 * (0.8 + Math.random() * 0.4);
                            
                            bulletHell.projectiles.push({
                                x: p.x + p.width/2 + Math.cos(angle) * radius,
                                y: p.y + p.height/2 + Math.sin(angle) * radius,
                                width: 5,
                                height: 5,
                                speed: speed,
                                vx: Math.cos(angle) * speed,
                                vy: Math.sin(angle) * speed,
                                damage: 1,
                                isPlayerProjectile: false,
                                color: `hsl(${(i * 10) % 360}, 100%, 60%)`,
                                acceleration: 1.01
                            });
                        }
                        break;
                }
                
                // Add explosion particles
                const particleCount = 50;
                for (let i = 0; i < particleCount; i++) {
                    p.explosionParticles.push({
                        x: p.x + p.width/2,
                        y: p.y + p.height/2,
                        vx: (Math.random() - 0.5) * 8,
                        vy: (Math.random() - 0.5) * 8,
                        size: Math.random() * 8 + 2,
                        color: ['#ff0000', '#ff5500', '#ffaa00', '#ffff00'][Math.floor(Math.random() * 4)],
                        lifetime: 30 + Math.random() * 30
                    });
                }
                
                // Set a short delay before removing the bomb to show particles
                p.lifetime = 30;
            }
            
            // Update explosion particles
            for (let j = p.explosionParticles.length - 1; j >= 0; j--) {
                const part = p.explosionParticles[j];
                part.x += part.vx;
                part.y += part.vy;
                part.vy += 0.1; // Gravity
                part.lifetime--;
                
                if (part.lifetime <= 0) {
                    p.explosionParticles.splice(j, 1);
                }
            }
            
            // Remove bomb after explosion is complete
            if (p.hasExploded && p.explosionParticles.length === 0) {
                projectiles.splice(i, 1);
                i--;
                continue;
            }
        }
        // Update homing projectiles
        else if (p.homing) {
            // Limit homing speed to prevent instant tracking
            const maxSpeed = p.maxHomingSpeed || 2.0;
            const homingStrength = p.homingStrength || 0.03;
            
            // Calculate direction to player
            const dx = (player.x + player.width/2) - (p.x + p.width/2);
            const dy = (player.y + player.height/2) - (p.y + p.height/2);
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist > 0) {
                // Normalize and apply homing
                const nx = dx / dist;
                const ny = dy / dist;
                
                // Update velocity with homing
                p.vx += nx * homingStrength;
                p.vy += ny * homingStrength;
                
                // Limit speed
                const currentSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
                if (currentSpeed > maxSpeed) {
                    p.vx = (p.vx / currentSpeed) * maxSpeed;
                    p.vy = (p.vy / currentSpeed) * maxSpeed;
                }
            }
            const desiredVx = (dx / dist) * p.maxHomingSpeed;
            const desiredVy = (dy / dist) * p.maxHomingSpeed;
            
            p.vx += (desiredVx - p.vx) * p.homingStrength;
            p.vy += (desiredVy - p.vy) * p.homingStrength;
            
            // Limit speed
            const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
            if (speed > p.maxHomingSpeed) {
                p.vx = (p.vx / speed) * p.maxHomingSpeed;
                p.vy = (p.vy / speed) * p.maxHomingSpeed;
            }
        }
        
        // Handle pulsing projectiles
        if (p.pulse) {
            const pulseSize = 1.0 + Math.sin(Date.now() * 0.01) * 0.3;
            p.width = p.baseSize * pulseSize;
        }
        
        if (p.acceleration) {
            p.speed *= p.acceleration;
            const angle = Math.atan2(p.vy, p.vx);
            p.vx = Math.cos(angle) * p.speed;
            p.vy = Math.sin(angle) * p.speed;
        }

        if (p.update) {
            p.update();
        } else if (p.vx !== undefined && p.vy !== undefined) {
            p.x += p.vx;
            p.y += p.vy;
        } else {
            p.x += p.speed * (p.isPlayerProjectile ? 1 : -1);
        }
        
        // Check for collision with player
        if (!p.isPlayerProjectile &&
            p.x < player.x + player.width && p.x + p.width > player.x &&
            p.y < player.y + player.height && p.y + p.height > player.y) {
            if (!player.isDashing && !player.isImmune) {
                takeHit();
            }
            projectiles.splice(i, 1);
        } 
        // Remove if off screen
        else if (p.x < -50 || p.x > canvas.width + 50 ||
                 p.y < -50 || p.y > canvas.height + 50) {
            projectiles.splice(i, 1);
        }
    }
}

// Update minions (simplified for bullet hell)
function updateMinions() {
    // Clear minions for now since we're focusing on bullet hell
    minions.length = 0;
}

// Draw health bars and UI
function drawHealthBars() {
    // Draw hit points (hearts)
    const heartSize = 20;
    const spacing = 5;
    // const totalWidth = (heartSize * player.maxHits) + (spacing * (player.maxHits - 1)); // Unused variable
    const startX = 20;
    
    for (let i = 0; i < player.maxHits; i++) {
        const x = startX + (i * (heartSize + spacing));
        if (i < player.hitsRemaining) {
            ctx.fillStyle = 'red';
            ctx.fillRect(x, 20, heartSize, heartSize);
        }
        ctx.strokeStyle = 'white';
        ctx.strokeRect(x, 20, heartSize, heartSize);
    }
    
    // Draw dash cooldown
    if (player.dashCooldown > 0) {
        const dashWidth = 100 * (1 - (player.dashCooldown / player.dashCooldownMax));
        ctx.fillStyle = 'rgba(0, 200, 255, 0.7)';
        ctx.fillRect(20, 50, dashWidth, 10);
        ctx.strokeStyle = 'white';
        ctx.strokeRect(20, 50, 100, 10);
    }
}

// Game loop
function gameLoop() {
    if (!gameRunning) return;
    
    // Clear canvas with semi-transparent black for motion blur effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Update game state
    updatePlayer();
    updateBulletHell();
    updateProjectiles();
    updateMinions();

    // Draw everything
    drawHealthBars();
    
    // Draw player with rotation based on movement
    ctx.save();
    ctx.translate(player.x + player.width/2, player.y + player.height/2);
    if (player.direction.x !== 0 || player.direction.y !== 0) {
        const angle = Math.atan2(player.direction.y, player.direction.x);
        ctx.rotate(angle);
    }
    
    // Draw player as a triangle
    ctx.beginPath();
    ctx.moveTo(player.width/2, 0);
    ctx.lineTo(-player.width/2, -player.width/2);
    ctx.lineTo(-player.width/2, player.width/2);
    ctx.closePath();
    
    // Visual feedback for dashing
    if (player.isDashing) {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.7)';
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
    } else {
        ctx.fillStyle = 'rgba(0, 100, 255, 0.9)';
    }
    ctx.fill();
    ctx.restore();
    
    bulletHell.sniperWarnings.forEach(warning => {
        const warningProgress = warning.timer / warning.warningTime;
        const isFlashing = warningProgress > 0.65 && Math.floor(warning.timer / 5) % 2 === 0;
        const lineLength = Math.hypot(canvas.width, canvas.height) * 1.5;

        ctx.save();
        ctx.globalAlpha = isFlashing ? 0.95 : 0.32 + warningProgress * 0.25;
        ctx.strokeStyle = '#ff4d5e';
        ctx.lineWidth = isFlashing ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(
            warning.x - Math.cos(warning.angle) * lineLength,
            warning.y - Math.sin(warning.angle) * lineLength
        );
        ctx.lineTo(
            warning.x + Math.cos(warning.angle) * lineLength,
            warning.y + Math.sin(warning.angle) * lineLength
        );
        ctx.stroke();
        ctx.restore();
    });

    // Draw projectiles
    projectiles.forEach(p => {
        if (p.type === 'bomb') {
            // Draw bomb
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x + p.width/2, p.y + p.height/2, p.width/2, 0, Math.PI * 2);
            ctx.fill();
            
            // Draw fuse if not exploded
            if (!p.hasExploded) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(p.x + p.width/2 - 5, p.y - 5);
                ctx.lineTo(p.x + p.width/2 - 10, p.y - 15);
                ctx.stroke();
            }
            
            // Draw explosion particles
            p.explosionParticles.forEach(part => {
                const alpha = Math.min(1, part.lifetime / 30);
                ctx.globalAlpha = alpha;
                ctx.fillStyle = part.color;
                ctx.beginPath();
                ctx.arc(part.x, part.y, part.size, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.globalAlpha = 1;
        } else if (p.isSniperShot) {
            ctx.save();
            ctx.translate(p.x + p.width / 2, p.y + p.height / 2);
            ctx.rotate(Math.atan2(p.vy, p.vx));
            ctx.fillStyle = p.color;
            ctx.shadowColor = '#ff4055';
            ctx.shadowBlur = 14;
            ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
            ctx.restore();
        } else if (p.isBigBullet) {
            // Draw big bullet as a glowing circle
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 30;
            ctx.beginPath();
            ctx.arc(p.x + p.width/2, p.y + p.height/2, p.width/2, 0, Math.PI * 2);
            ctx.fill();
            
            // Add a pulsing border
            const pulse = Math.sin(Date.now() * 0.01) * 0.5 + 0.5;
            ctx.strokeStyle = `rgba(255, 0, 255, ${0.5 + pulse * 0.5})`;
            ctx.lineWidth = 3;
            ctx.stroke();
            
            ctx.shadowBlur = 0;
        } else if (p.rotating) {
            ctx.save();
            ctx.globalAlpha = p.isDistraction ? 0.42 : 1;
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 4;
            
            // Draw the filled circle
            ctx.beginPath();
            ctx.arc(p.x + p.width/2, p.y + p.height/2, p.width/2, 0, Math.PI * 2);
            ctx.fill();
            
            // Draw black outline
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            ctx.shadowBlur = 0;
            ctx.restore();
        } else {
            // Draw regular projectiles
            if (p.color) {
                ctx.fillStyle = p.color;
            } else {
                ctx.fillStyle = p.isPlayerProjectile ? 'rgba(0, 255, 0, 0.8)' : 'rgba(255, 50, 50, 0.8)';
            }
            
            // Add glow effect for certain projectiles
            if (p.color) {
                ctx.shadowColor = p.color;
                ctx.shadowBlur = 10;
            }
            
            // Draw the projectile
            ctx.fillRect(p.x, p.y, p.width, p.height);
            
            if (p.color) {
                ctx.shadowBlur = 0;
            }
        }
    });
    
    // Draw lasers
    bulletHell.lasers.forEach(laser => {
        // Draw lasting trail segments first so the laser sits on top
        if (laser.trails && laser.trails.length > 0) {
            laser.trails.forEach(trail => {
                const alpha = Math.max(0, trail.life / laser.trailLifetime) * 0.6;
                ctx.save();
                ctx.translate(trail.x, trail.y);
                ctx.rotate(trail.angle);
                ctx.fillStyle = `rgba(255, 0, 0, ${alpha})`;
                ctx.fillRect(-trail.width / 2, -trail.height / 2, trail.width, trail.height);
                ctx.restore();
            });
        }

        ctx.save();
        ctx.translate(laser.x, laser.y);
        ctx.rotate(laser.angle);

        if (laser.isWarning) {
            // Draw warning (red outline)
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.7)';
            ctx.lineWidth = 3;
            ctx.strokeRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);
            
            // Pulsing effect
            const pulse = Math.sin(Date.now() * 0.01) * 0.5 + 0.5;
            ctx.fillStyle = `rgba(255, 0, 0, ${0.1 + pulse * 0.1})`;
            ctx.fillRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);
        } else {
            // Draw active laser
            const gradient = ctx.createLinearGradient(-laser.width / 2, 0, laser.width / 2, 0);
            gradient.addColorStop(0, 'rgba(255, 100, 100, 0.9)');
            gradient.addColorStop(0.5, 'rgba(255, 200, 200, 0.9)');
            gradient.addColorStop(1, 'rgba(255, 100, 100, 0.9)');
            
            ctx.fillStyle = gradient;
            ctx.fillRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);
            
            // Add glow
            ctx.shadowColor = 'rgba(255, 100, 100, 0.8)';
            ctx.shadowBlur = 20;
            ctx.fillRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);
            ctx.shadowBlur = 0;
        }
        
        ctx.restore();
    });

    // Update score based on survival time
    if (gameRunning) {
        score = Math.floor((Date.now() - gameStartTime) / 1000);
    }
    
    requestAnimationFrame(gameLoop);
}

// Initialize game
async function initGame() {
    try {
        // Initialize audio context if it's suspended (required by some browsers)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        // Initialize sounds if not already done
        if (Object.keys(sounds).length === 0) {
            initSounds();
            
            // Start background music if available
            if (sounds.background) {
                playSound('background', 0.3);
            }
        }
    
    } catch (e) {
        console.warn('Error initializing game:', e);
    }
    
    // Reset player properties (0.75 of original size)
    player.x = canvas.width / 2 - 11; // 30 * 0.75 / 2
    player.y = canvas.height / 2 - 11;
    player.width = 22.5; // 30 * 0.75
    player.height = 22.5;
    player.speed = 5;
    player.isDashing = false;
    player.dashCooldown = 0;
    player.dashDuration = 10;
    player.dashSpeed = 15;
    player.isImmune = false;
    player.immunityTimer = 0;
    player.hitsRemaining = 8;
    player.maxHits = 8;
    player.direction = { x: 0, y: 0 };
    player.dashDirection = { x: 1, y: 0 };
    player.healTimer = 0;
    
    // Reset game state
    score = 0;
    gameStartTime = Date.now();
    projectiles = [];
    bulletHell.lasers = [];
    bulletHell.sniperWarnings = [];
    bulletHell.gameTime = 0;
    bulletHell.difficulty = 1;
    bulletHell.lastPatternTime = 0;
    bulletHell.patterns.forEach(pattern => {
        pattern.lastUsed = -9999;
    });
    
    // Show game canvas, hide menus
    document.getElementById('start-menu').style.display = 'none';
    document.getElementById('game-over').style.display = 'none';
    canvas.style.display = 'block';
    
    // Start game loop if not already running
    if (!gameRunning) {
        gameRunning = true;
        gameStarted = true;
        gameLoop();
    }
}

// Show game over screen
function showGameOver() {
    gameRunning = false;
    survivalTime = Math.floor((Date.now() - gameStartTime) / 1000);
    
    // Update high score if needed
    if (survivalTime > highScore) {
        highScore = survivalTime;
        localStorage.setItem('highScore', highScore);
    }
    
    // Update UI
    document.getElementById('score-display').innerHTML = `
        Survived: ${survivalTime} seconds<br>
        <span style="color: #ffcc00">Best: ${highScore} seconds</span>
    `;
    document.getElementById('game-over').style.display = 'flex';
    canvas.style.display = 'none';
}

// Setup event listeners for UI
function setupUIListeners() {
    // Start button
    document.getElementById('start-button').addEventListener('click', () => {
        initGame();
    });
    
    // Restart button
    document.getElementById('restart-button').addEventListener('click', () => {
        initGame();
    });
}

// Check game over
function checkGameOver() {
    if (player.hitsRemaining <= 0 && gameRunning) {
        showGameOver();
    }
}

// Initialize game when the window loads
window.onload = function() {
    setupUIListeners();
    document.getElementById('start-menu').style.display = 'flex';
};
