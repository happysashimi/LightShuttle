import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';

const WIDTH = 960;
const HEIGHT = 600;
const PLAYER_SIZE = 13;

function drawFrame(ctx, game) {
  const { player, bullets, particles, stars, time, dashFlash } = game;
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#080b16';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = 'rgba(104, 130, 190, 0.07)';
  ctx.lineWidth = 1;
  for (let x = 0; x < WIDTH; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke(); }
  for (let y = 0; y < HEIGHT; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); ctx.stroke(); }
  stars.forEach((star) => {
    ctx.fillStyle = `rgba(153, 188, 255, ${star.alpha})`;
    ctx.fillRect(star.x, star.y, star.size, star.size);
  });
  bullets.forEach((bullet) => {
    ctx.beginPath(); ctx.fillStyle = '#ff5d7a'; ctx.shadowColor = '#ff456f'; ctx.shadowBlur = 13;
    ctx.arc(bullet.x, bullet.y, bullet.r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.shadowBlur = 0;
  particles.forEach((particle) => {
    ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
    ctx.fillStyle = particle.color;
    ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
  });
  ctx.globalAlpha = 1;
  if (player.invulnerable > 0 && Math.floor(time * 13) % 2 === 0) return;
  const glow = player.dash > 0 || dashFlash > 0;
  ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(player.angle);
  ctx.shadowColor = glow ? '#b3fff4' : '#55f1d0'; ctx.shadowBlur = glow ? 28 : 16;
  ctx.fillStyle = '#d6fff7'; ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-11, -10); ctx.lineTo(-6, 0); ctx.lineTo(-11, 10); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#54e8cc'; ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(-17 - Math.random() * 4, 0); ctx.lineTo(-8, 4); ctx.closePath(); ctx.fill(); ctx.restore();
}

function createGame() {
  return {
    player: { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, angle: 0, dash: 0, dashCooldown: 0, invulnerable: 0, hp: 3 },
    bullets: [], particles: [],
    stars: Array.from({ length: 100 }, () => ({ x: Math.random() * WIDTH, y: Math.random() * HEIGHT, size: Math.random() * 2 + 1, alpha: Math.random() * 0.5 + 0.15 })),
    time: 0, spawn: 0, dashFlash: 0, score: 0, lastShot: 0,
  };
}

export default function App() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const keysRef = useRef(new Set());
  const [status, setStatus] = useState('ready');
  const [score, setScore] = useState(0);
  const [soundOn, setSoundOn] = useState(false);

  const start = useCallback(() => {
    gameRef.current = createGame(); keysRef.current.clear(); setScore(0); setStatus('playing');
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return undefined;
    let raf = 0;
    let previous = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const game = gameRef.current;
      if (!game) return;
      const dt = Math.min((now - (previous || now)) / 1000, 0.035);
      previous = now;
      if (status === 'playing') {
        const p = game.player;
        const keys = keysRef.current;
        const dx = Number(keys.has('ArrowRight') || keys.has('d')) - Number(keys.has('ArrowLeft') || keys.has('a'));
        const dy = Number(keys.has('ArrowDown') || keys.has('s')) - Number(keys.has('ArrowUp') || keys.has('w'));
        if (dx || dy) {
          const length = Math.hypot(dx, dy); const nx = dx / length; const ny = dy / length;
          p.angle = Math.atan2(ny, nx);
          if (p.dash > 0) { p.vx = nx * 600; p.vy = ny * 600; }
          else { p.vx += (nx * 300 - p.vx) * Math.min(1, dt * 9); p.vy += (ny * 300 - p.vy) * Math.min(1, dt * 9); }
        } else if (p.dash <= 0) { p.vx *= Math.max(0, 1 - dt * 7); p.vy *= Math.max(0, 1 - dt * 7); }
        p.x = Math.max(16, Math.min(WIDTH - 16, p.x + p.vx * dt));
        p.y = Math.max(16, Math.min(HEIGHT - 16, p.y + p.vy * dt));
        p.dash = Math.max(0, p.dash - dt); p.dashCooldown = Math.max(0, p.dashCooldown - dt); p.invulnerable = Math.max(0, p.invulnerable - dt);
        game.dashFlash = Math.max(0, game.dashFlash - dt);
        game.time += dt; game.score = Math.floor(game.time * 10); game.spawn -= dt;
        if (game.spawn <= 0) {
          const edgeX = Math.random() < 0.5 ? (Math.random() < 0.5 ? -10 : WIDTH + 10) : Math.random() * WIDTH;
          const edgeY = edgeX === -10 || edgeX === WIDTH + 10 ? Math.random() * HEIGHT : (Math.random() < 0.5 ? -10 : HEIGHT + 10);
          const targetAngle = Math.atan2(p.y - edgeY, p.x - edgeX) + (Math.random() - 0.5) * 0.45;
          game.bullets.push({ x: edgeX, y: edgeY, vx: Math.cos(targetAngle) * (105 + game.time * 1.8), vy: Math.sin(targetAngle) * (105 + game.time * 1.8), r: 5 });
          game.spawn = Math.max(0.22, 0.82 - game.time * 0.008 + Math.random() * 0.35);
        }
        game.bullets = game.bullets.filter((b) => {
          b.x += b.vx * dt; b.y += b.vy * dt;
          if (p.invulnerable <= 0 && Math.hypot(b.x - p.x, b.y - p.y) < b.r + PLAYER_SIZE * 0.65) {
            p.hp -= 1; p.invulnerable = 1.05;
            for (let i = 0; i < 14; i++) game.particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 190, vy: (Math.random() - 0.5) * 190, life: 0.5, maxLife: 0.5, size: Math.random() * 4 + 2, color: '#ff6684' });
            if (p.hp <= 0) { setScore(game.score); setStatus('over'); }
            return false;
          }
          return b.x > -30 && b.x < WIDTH + 30 && b.y > -30 && b.y < HEIGHT + 30;
        });
        game.particles = game.particles.filter((particle) => { particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.life -= dt; return particle.life > 0; });
        if (Math.floor(game.time * 10) !== Math.floor((game.time - dt) * 10)) setScore(game.score);
      }
      if (gameRef.current) drawFrame(ctx, gameRef.current);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(key)) event.preventDefault();
      if (status === 'playing' && key === ' ' && !event.repeat) {
        const game = gameRef.current; const p = game?.player;
        if (p && p.dashCooldown <= 0) {
          let dx = Number(keysRef.current.has('ArrowRight') || keysRef.current.has('d')) - Number(keysRef.current.has('ArrowLeft') || keysRef.current.has('a'));
          let dy = Number(keysRef.current.has('ArrowDown') || keysRef.current.has('s')) - Number(keysRef.current.has('ArrowUp') || keysRef.current.has('w'));
          const length = Math.hypot(dx, dy) || 1; dx = dx / length || Math.cos(p.angle); dy = dy / length || Math.sin(p.angle);
          p.vx = dx * 670; p.vy = dy * 670; p.dash = 0.18; p.dashCooldown = 1.15; p.invulnerable = 0.26; game.dashFlash = 0.22;
        }
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(key)) keysRef.current.add(key);
      if (status !== 'playing' && (key === 'Enter')) start();
    };
    const onKeyUp = (event) => keysRef.current.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [status, start]);

  const toggleSound = () => setSoundOn((current) => !current);
  return (
    <main className="game-shell">
      <header className="topbar"><a className="wordmark" href="#home" aria-label="Light Shuttle home"><span className="logo-mark">✦</span> LIGHT<span className="wordmark-accent">SHUTTLE</span></a><div className="topbar-right"><span className="status-dot" /> ARCADE / 001 <button className="sound-button" onClick={toggleSound} aria-label={soundOn ? 'Mute sound' : 'Enable sound'}>{soundOn ? 'SOUND ON' : 'SOUND OFF'}</button></div></header>
      <section className="game-layout" aria-label="Light Shuttle game">
        <div className="intro"><div className="eyebrow"><span /> SURVIVAL PROTOCOL <span>—</span> 01</div><h1>Stay in the<br /><span>light.</span></h1><p className="intro-copy">A little ship. A lot of incoming.<br />How long can you hold the line?</p><div className="record-card"><span className="record-icon">✳</span><div><span className="record-label">CURRENT RUN</span><strong>{String(score).padStart(4, '0')} <small>PTS</small></strong></div><span className="record-divider" /><div className="lives"><span className="record-label">HULL</span><strong>{status === 'playing' && gameRef.current ? '●'.repeat(gameRef.current.player.hp) + '○'.repeat(3 - gameRef.current.player.hp) : '●●●'}</strong></div></div></div>
        <div className="arena-wrap">
          <div className="arena-top"><span>SECTOR 07 <i>·</i> DEEP SPACE</span><span className="live-label"><b /> {status === 'playing' ? 'LIVE' : 'READY'}</span></div>
          <div className="arena" id="game-arena"><canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label="Game arena. Move to dodge incoming projectiles." />
            {status !== 'playing' && <div className="game-overlay"><div className="overlay-content"><div className="ship-emblem">✦</div><div className="overlay-kicker">{status === 'over' ? 'SIGNAL LOST' : 'YOUR SHIP IS READY'}</div><h2>{status === 'over' ? <>That was<br /><span>a close one.</span></> : <>Ready when<br /><span>you are.</span></>}</h2><p>{status === 'over' ? `You lasted ${Math.floor(score / 10)} seconds. Think you can beat that?` : 'Dodge the incoming. Dash through danger.'}</p><button className="start-button" onClick={start}>{status === 'over' ? 'RUN IT BACK' : 'START RUN'} <span>↗</span></button><div className="enter-hint">PRESS ENTER TO {status === 'over' ? 'RESTART' : 'BEGIN'}</div></div></div>}
          </div>
          <div className="arena-footer"><span><i className="keycap">W</i><i className="keycap">A</i><i className="keycap">S</i><i className="keycap">D</i> <b>MOVE</b></span><span><i className="keycap wide">SPACE</i> <b>DASH</b></span><span className="footer-tip">TIME YOUR DASH. TRUST YOUR INSTINCTS.</span></div>
        </div>
      </section>
      <footer className="page-footer"><span>BUILT FOR THE IN-BETWEEN</span><span>NO SAVE POINTS. JUST ONE MORE TRY.</span><span>© LIGHT SHUTTLE — 2026</span></footer>
    </main>
  );
}
