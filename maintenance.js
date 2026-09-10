import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./firebase.js";

// --- THEME SYNC ---
const themeToggleBtn = document.getElementById('themeToggleBtn');
function applyTheme(theme) {
    const isDark = theme === 'dark';
    if (isDark) {
        document.body.classList.add('dark-theme', 'dark-mode');
    } else {
        document.body.classList.remove('dark-theme', 'dark-mode');
    }
    document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
    document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
}

const savedTheme = localStorage.getItem('appTheme') || localStorage.getItem('theme') || 'light';
applyTheme(savedTheme);

themeToggleBtn?.addEventListener('click', () => {
    const isDarkNow = !document.body.classList.contains('dark-theme');
    const newTheme = isDarkNow ? 'dark' : 'light';
    localStorage.setItem('appTheme', newTheme);
    localStorage.setItem('theme', newTheme);
    applyTheme(newTheme);
});

// --- PREVIEW MODE CHECK ---
const urlParams = new URLSearchParams(window.location.search);
const isPreview = urlParams.get('preview') === '1' || urlParams.get('preview') === 'true';

// --- AUTO ROUTE AUTHENTICATED STAFF TO ADMIN ---
onAuthStateChanged(auth, (user) => {
    if (user && !isPreview) {
        // If staff is signed in and not previewing, offer quick direct link or redirect
        const staffBtn = document.getElementById('btnOpenStaffLogin');
        if (staffBtn) {
            staffBtn.innerHTML = `<span>Go to Admin Dashboard</span>`;
            staffBtn.onclick = () => window.location.href = "admin.html";
        }
    }
});

// --- UI ELEMENTS ---
const displayTitle = document.getElementById('displayTitle');
const displayMessage = document.getElementById('displayMessage');
const displayEstTime = document.getElementById('displayEstTime');
const maintenanceBadgeText = document.getElementById('maintenanceBadgeText');
const displayContactNote = document.getElementById('displayContactNote');
const contactNoteWrapper = document.getElementById('contactNote');
const timeInfoBox = document.getElementById('timeInfoBox');
const countdownGrid = document.getElementById('countdownGrid');
const cdHours = document.getElementById('cdHours');
const cdMinutes = document.getElementById('cdMinutes');
const cdSeconds = document.getElementById('cdSeconds');
const restoredBanner = document.getElementById('restoredBanner');
const redirectCounter = document.getElementById('redirectCounter');

let countdownInterval = null;

function startCountdown(targetIsoDate) {
    if (countdownInterval) clearInterval(countdownInterval);
    if (!targetIsoDate) {
        countdownGrid.style.display = 'none';
        return;
    }

    const targetTime = new Date(targetIsoDate).getTime();
    if (isNaN(targetTime)) {
        countdownGrid.style.display = 'none';
        return;
    }

    countdownGrid.style.display = 'flex';

    const updateTimer = () => {
        const now = new Date().getTime();
        const diff = targetTime - now;

        if (diff <= 0) {
            cdHours.innerText = '00';
            cdMinutes.innerText = '00';
            cdSeconds.innerText = '00';
            clearInterval(countdownInterval);
            return;
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);

        cdHours.innerText = String(hours).padStart(2, '0');
        cdMinutes.innerText = String(mins).padStart(2, '0');
        cdSeconds.innerText = String(secs).padStart(2, '0');
    };

    updateTimer();
    countdownInterval = setInterval(updateTimer, 1000);
}

function renderMaintenanceData(data) {
    if (!data) return;

    // Title & Notice
    if (data.title) displayTitle.innerText = data.title;
    if (data.message) displayMessage.innerText = data.message;
    if (data.category) maintenanceBadgeText.innerText = data.category;

    // Estimated Downtime
    if (data.estimatedTime) {
        displayEstTime.innerText = data.estimatedTime;
        timeInfoBox.style.display = 'flex';
    } else if (!data.showCountdown && !data.targetDateTime) {
        timeInfoBox.style.display = 'none';
    }

    // Countdown
    if (data.showCountdown && data.targetDateTime) {
        startCountdown(data.targetDateTime);
    } else {
        countdownGrid.style.display = 'none';
    }

    // Contact Note
    if (data.contactNote) {
        displayContactNote.innerText = data.contactNote;
        contactNoteWrapper.style.display = 'inline-flex';
    } else {
        contactNoteWrapper.style.display = 'none';
    }

    // Check if maintenance is turned OFF in live mode
    if (!isPreview && data.enabled === false) {
        triggerAutoRedirect();
    }
}

let isRedirecting = false;
function triggerAutoRedirect() {
    if (isRedirecting) return;
    isRedirecting = true;
    if (restoredBanner) restoredBanner.style.display = 'block';

    let count = 3;
    if (redirectCounter) redirectCounter.innerText = count;

    const timer = setInterval(() => {
        count--;
        if (redirectCounter) redirectCounter.innerText = count;
        if (count <= 0) {
            clearInterval(timer);
            window.location.replace("index.html");
        }
    }, 1000);
}

// --- REAL-TIME FIRESTORE LISTENER ---
async function listenMaintenanceConfig() {
    try {
        // Listen to primary config
        onSnapshot(doc(db, "system_settings", "maintenance"), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                renderMaintenanceData(data);
            }
        }, async (err) => {
            console.warn("Snapshot error on system_settings/maintenance:", err);
            // Fallback to static get
            try {
                const sSnap = await getDoc(doc(db, "config", "maintenance"));
                if (sSnap.exists()) renderMaintenanceData(sSnap.data());
            } catch (e) {
                console.warn("Fallback error:", e);
            }
        });
    } catch (e) {
        console.warn("Listener initialization error:", e);
    }
}

listenMaintenanceConfig();

// Refresh button
document.getElementById('btnRefreshStatus')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnRefreshStatus');
    if (btn) {
        btn.style.opacity = '0.6';
        btn.querySelector('span').innerText = 'Checking...';
    }
    try {
        const snap = await getDoc(doc(db, "system_settings", "maintenance"));
        if (snap.exists()) {
            const data = snap.data();
            renderMaintenanceData(data);
            if (!data.enabled) {
                triggerAutoRedirect();
                return;
            }
        }
    } catch (e) {
        console.error("Refresh check error:", e);
    } finally {
        setTimeout(() => {
            if (btn) {
                btn.style.opacity = '1';
                btn.querySelector('span').innerText = 'Refresh Status';
            }
        }, 600);
    }
});

// --- STAFF / ADMIN LOGIN MODAL HANDLER ---
const staffModal = document.getElementById('staffLoginModal');
const btnOpenStaff = document.getElementById('btnOpenStaffLogin');
const btnCloseStaff = document.getElementById('btnCloseStaffModal');
const staffLoginForm = document.getElementById('staffLoginForm');
const staffLoginError = document.getElementById('staffLoginError');
const btnStaffSubmit = document.getElementById('btnStaffSubmit');

btnOpenStaff?.addEventListener('click', () => {
    if (staffModal) staffModal.style.display = 'flex';
});

btnCloseStaff?.addEventListener('click', () => {
    if (staffModal) staffModal.style.display = 'none';
});

staffModal?.addEventListener('click', (e) => {
    if (e.target === staffModal) staffModal.style.display = 'none';
});

staffLoginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('staffEmail').value.trim();
    const password = document.getElementById('staffPassword').value.trim();

    if (!email || !password) return;

    if (staffLoginError) staffLoginError.style.display = 'none';
    if (btnStaffSubmit) {
        btnStaffSubmit.disabled = true;
        btnStaffSubmit.innerText = 'Signing In...';
    }

    try {
        await signInWithEmailAndPassword(auth, email, password);
        window.location.href = "admin.html";
    } catch (err) {
        console.error("Staff login error:", err);
        if (staffLoginError) {
            staffLoginError.innerText = "Invalid credentials or unauthorized login.";
            staffLoginError.style.display = 'block';
        }
    } finally {
        if (btnStaffSubmit) {
            btnStaffSubmit.disabled = false;
            btnStaffSubmit.innerText = 'Sign In to Admin Portal';
        }
    }
});
