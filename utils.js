// utils.js - Shared Security & Formatting Utilities

/**
 * Sanitizes an untrusted string to prevent Cross-Site Scripting (XSS) attacks.
 * Replaces HTML special characters with their safe HTML entity representations.
 * @param {string} str - Raw untrusted input string
 * @returns {string} - Escaped safe string
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Converts an ISO timestamp string into a clean relative time string (e.g. 5m, 2h, 3d)
 * @param {string|Date} timestamp 
 * @returns {string}
 */
export function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const postDate = new Date(timestamp);
    const now = new Date();
    const secondsPast = Math.floor((now - postDate) / 1000);

    if (secondsPast < 0) return 'just now';
    if (secondsPast < 60) return `${Math.max(1, secondsPast)}s`;
    
    const minutesPast = Math.floor(secondsPast / 60);
    if (minutesPast < 60) return `${minutesPast}m`;
    
    const hoursPast = Math.floor(minutesPast / 60);
    if (hoursPast < 24) return `${hoursPast}h`;
    
    const daysPast = Math.floor(hoursPast / 24);
    if (daysPast < 7) return `${daysPast}d`;
    
    const weeksPast = Math.floor(daysPast / 7);
    if (weeksPast < 4) return `${weeksPast}w`;
    
    return postDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Formats a Date object or ISO string into YYYY-MM-DD (or friendly date string)
 * @param {Date|string|number} date 
 * @returns {string}
 */
export function formatDate(date) {
    if (!date) return '';
    try {
        const d = (date instanceof Date) ? date : new Date(date);
        if (isNaN(d.getTime())) return String(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        return String(date);
    }
}

/**
 * Triggers a vibrant, lightweight particle celebration burst at a specified (x, y) origin or screen center.
 * @param {number} [x] - Origin X coordinate
 * @param {number} [y] - Origin Y coordinate
 * @param {number} [count=24] - Number of sparkle particles
 */
export function triggerCelebration(x, y, count = 24) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
    }
    const originX = x ?? (window.innerWidth / 2);
    const originY = y ?? (window.innerHeight / 2);
    const colors = ['#2563eb', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#38bdf8'];

    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        particle.className = 'celebration-sparkle';
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = Math.floor(Math.random() * 8) + 6;
        const angle = (Math.PI * 2 * i) / count + (Math.random() * 0.4 - 0.2);
        const distance = Math.floor(Math.random() * 90) + 50;
        const dx = `${Math.cos(angle) * distance}px`;
        const dy = `${Math.sin(angle) * distance}px`;

        particle.style.left = `${originX}px`;
        particle.style.top = `${originY}px`;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.backgroundColor = color;
        particle.style.setProperty('--dx', dx);
        particle.style.setProperty('--dy', dy);

        document.body.appendChild(particle);

        particle.addEventListener('animationend', () => {
            particle.remove();
        });
    }
}

/**
 * Attaches a dynamic ripple effect to interactive buttons
 * @param {HTMLElement|string} target - Button element or selector
 */
export function attachRippleEffect(target) {
    const elements = typeof target === 'string' ? document.querySelectorAll(target) : [target];
    elements.forEach(el => {
        if (!el || el.dataset.hasRippleAttached) return;
        el.dataset.hasRippleAttached = 'true';
        el.classList.add('has-ripple');

        el.addEventListener('pointerdown', (e) => {
            const rect = el.getBoundingClientRect();
            const circle = document.createElement('span');
            const diameter = Math.max(rect.width, rect.height);
            const radius = diameter / 2;

            circle.style.width = circle.style.height = `${diameter}px`;
            circle.style.left = `${e.clientX - rect.left - radius}px`;
            circle.style.top = `${e.clientY - rect.top - radius}px`;
            circle.classList.add('ripple-effect');

            const existingRipple = el.querySelector('.ripple-effect');
            if (existingRipple) {
                existingRipple.remove();
            }

            el.appendChild(circle);

            circle.addEventListener('animationend', () => {
                circle.remove();
            });
        });
    });
}

/**
 * Initializes IntersectionObserver to stagger reveal elements with .animate-fade-up
 */
export function initStaggeredReveals() {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-fade-up');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.stagger-reveal').forEach(el => observer.observe(el));
}

// Make available globally on window for non-module script contexts
if (typeof window !== 'undefined') {
    window.triggerCelebration = triggerCelebration;
    window.attachRippleEffect = attachRippleEffect;
    window.initStaggeredReveals = initStaggeredReveals;
}

