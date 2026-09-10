import { collection, query, where, getDocs, doc, getDoc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./firebase.js";
import { escapeHtml } from "./utils.js";

// Auto-route authenticated teachers/admins directly to admin dashboard
onAuthStateChanged(auth, (user) => {
    if (user && !sessionStorage.getItem('studentLoggedInSession')) {
        window.location.replace("admin.html");
    }
});

let cachedExamScores = [];

// --- THEME TOGGLE SYSTEM ---
// --- THEME TOGGLE SYSTEM ---
const themeToggleBtn = document.getElementById('themeToggleBtn');
const mainThemeIcon = document.getElementById('mainThemeIcon');
const mainThemeText = document.getElementById('mainThemeText');

// Replace these with your Google Drive image URLs
const DARK_MODE_ICON_URL = 'https://lh3.googleusercontent.com/d/1N2sZUgBKIQCviZYYm4ibVWCXc4XVhnnh';
const LIGHT_MODE_ICON_URL = 'https://lh3.googleusercontent.com/d/1_NNJ0sMnU6x1pLW1GiV8FmfL9bPccVhd';

function applyTheme(theme) {
    const isDark = theme === 'dark';
    if (isDark) {
        document.body.classList.add('dark-theme', 'dark-mode');
        if (mainThemeIcon) mainThemeIcon.src = LIGHT_MODE_ICON_URL;
        if (mainThemeText) mainThemeText.innerText = 'Light Mode';
    } else {
        document.body.classList.remove('dark-theme', 'dark-mode');
        if (mainThemeIcon) mainThemeIcon.src = DARK_MODE_ICON_URL;
        if (mainThemeText) mainThemeText.innerText = 'Dark Mode';
    }
    // Strict SVG Icon Toggle: When light mode -> show Moon, hide Sun. When dark mode -> show Sun, hide Moon.
    document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
    document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
}

// Load saved theme on startup
const savedTheme = localStorage.getItem('appTheme') || localStorage.getItem('theme') || 'light';
applyTheme(savedTheme);

// Handle click event
themeToggleBtn?.addEventListener('click', () => {
    const isDarkNow = !document.body.classList.contains('dark-theme');
    const newTheme = isDarkNow ? 'dark' : 'light';
    localStorage.setItem('appTheme', newTheme);
    localStorage.setItem('theme', newTheme);
    applyTheme(newTheme);
});

// --- STUDENT LOGIN & SESSION SYSTEM ---
let currentLoggedInStudent = null;
let studentReminderUnsubscribe = null;

async function checkMaintenanceStatus() {
    try {
        let snap = await getDoc(doc(db, "system_settings", "maintenance"));
        if (!snap.exists()) {
            snap = await getDoc(doc(db, "config", "maintenance"));
        }
        if (snap.exists()) {
            const data = snap.data();
            return !!data.enabled;
        }
    } catch (e) {
        console.warn("Could not check maintenance status:", e);
    }
    return localStorage.getItem('maintenanceMode') === 'true';
}

// Real-time listener for maintenance changes while on index.html
try {
    onSnapshot(doc(db, "system_settings", "maintenance"), (snap) => {
        if (snap.exists() && snap.data().enabled && !auth.currentUser) {
            window.location.replace("maintenance.html");
        }
    });
} catch (e) {
    console.warn("Live maintenance listener error:", e);
}

async function checkStudentSession() {
    const isMaintenance = await checkMaintenanceStatus();
    if (isMaintenance && !auth.currentUser) {
        window.location.replace("maintenance.html");
        return;
    }

    const saved = sessionStorage.getItem('studentLoggedInSession');
    const overlay = document.getElementById('studentLoginOverlay');
    
    if (saved) {
        currentLoggedInStudent = JSON.parse(saved);
        if (overlay) overlay.style.display = 'none';
        updateGreetingBanner(currentLoggedInStudent.name, currentLoggedInStudent.birthDate);
        fetchStudentUnifiedData(currentLoggedInStudent.code);
        loadNewsTicker();
        listenActiveStudentAttendance();
        listenStudentAssignmentReminders(currentLoggedInStudent.code);
    } else {
        if (overlay) overlay.style.display = 'flex';
        updateGreetingBanner();
    }
}

// Student Login Button Click Handler
document.getElementById('studentLoginBtn')?.addEventListener('click', handleStudentLogin);
document.getElementById('loginStudentPassword')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleStudentLogin();
});
document.getElementById('loginStudentUsername')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleStudentLogin();
});

async function handleStudentLogin() {
    const rawUser = document.getElementById('loginStudentUsername').value.trim();
    const rawPass = document.getElementById('loginStudentPassword').value.trim();
    const errBox = document.getElementById('loginErrorMessage');

    if (errBox) errBox.classList.add('hidden');

    if (!rawUser || !rawPass) {
        if (errBox) {
            errBox.innerText = "Please fill out both username and password fields.";
            errBox.classList.remove('hidden');
        }
        return;
    }

    // 1. TEACHER / ADMIN LOGIN (If email address entered)
    if (rawUser.includes('@')) {
        try {
            await signInWithEmailAndPassword(auth, rawUser, rawPass);
            window.location.href = "admin.html";
            return;
        } catch (err) {
            console.error("Staff Login Error:", err);
            if (errBox) {
                let msg = "Staff Login Failed: Invalid email or password.";
                if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
                    msg = "Invalid email or password. Please check your credentials.";
                } else if (err.code === 'auth/too-many-requests') {
                    msg = "Too many failed attempts. Please wait a moment and try again.";
                }
                errBox.innerText = msg;
                errBox.classList.remove('hidden');
            }
            return;
        }
    }

    // Check maintenance mode before student logs in
    const isMaintenance = await checkMaintenanceStatus();
    if (isMaintenance) {
        window.location.replace("maintenance.html");
        return;
    }

    // 2. STUDENT LOGIN (Unique code)
    const userIn = rawUser.toUpperCase();
    const passIn = rawPass.toUpperCase();

    if (userIn !== passIn) {
        if (errBox) {
            errBox.innerText = "For students, your Username and Password must both be your 5-character student code.";
            errBox.classList.remove('hidden');
        }
        return;
    }

    try {
        const studentRef = doc(db, "students", userIn);
        const studentSnap = await getDoc(studentRef);

        if (!studentSnap.exists()) {
            if (errBox) {
                errBox.innerText = `Student code "${userIn}" not found in database.`;
                errBox.classList.remove('hidden');
            }
            return;
        }

        const sData = studentSnap.data();
        const studentBirthDate = sData.birthDate || sData.dateOfBirth || '';
        currentLoggedInStudent = {
            code: userIn,
            name: sData.studentName || sData.name || 'Student',
            studentClass: sData.studentClass || sData.class || 'Unassigned',
            birthDate: studentBirthDate
        };

        // Save session in sessionStorage so it persists across page navigation (Quiz, Timeline, etc.)
        sessionStorage.setItem('studentLoggedInSession', JSON.stringify(currentLoggedInStudent));
        sessionStorage.setItem('studentTimelineSession', JSON.stringify({
            type: 'student',
            name: currentLoggedInStudent.name,
            code: currentLoggedInStudent.code,
            studentClass: currentLoggedInStudent.studentClass,
            birthDate: studentBirthDate
        }));

        const overlay = document.getElementById('studentLoginOverlay');
        if (overlay) overlay.style.display = 'none';

        updateGreetingBanner(currentLoggedInStudent.name, studentBirthDate);
        fetchStudentUnifiedData(userIn);
        loadNewsTicker();
        listenActiveStudentAttendance();
        listenStudentAssignmentReminders(userIn);

    } catch (err) {
        console.error("Student login error:", err);
        if (errBox) {
            errBox.innerText = "Connection error. Please try logging in again.";
            errBox.classList.remove('hidden');
        }
    }
}

// Student Logout Handler
document.getElementById('studentLogoutBtn')?.addEventListener('click', () => {
    sessionStorage.removeItem('studentLoggedInSession');
    sessionStorage.removeItem('studentTimelineSession');
    location.reload();
});

// Auto-fetch profile for logged in code
async function fetchStudentUnifiedData(codeInput) {
    const profileCard = document.getElementById('profileResultCard');
    if (profileCard) profileCard.classList.add('hidden');

    if (!codeInput) return;

    const upperCode = codeInput.toString().trim().toUpperCase();

    try {
        const scoreQuery = query(collection(db, "exam_scores"), where("studentCode", "==", upperCode));
        const pointQuery = query(collection(db, "student_points"), where("studentCode", "==", upperCode));
        const studentRef = doc(db, "students", upperCode);

        const [scoreSnap, pointSnap, studentDocSnap] = await Promise.all([
            getDocs(scoreQuery),
            getDocs(pointQuery),
            getDoc(studentRef)
        ]);

        let studentBirthDate = currentLoggedInStudent ? (currentLoggedInStudent.birthDate || '') : '';
        let fetchedName = '';
        let fetchedClass = '';

        if (studentDocSnap && studentDocSnap.exists()) {
            const sData = studentDocSnap.data();
            studentBirthDate = sData.birthDate || sData.dateOfBirth || studentBirthDate;
            fetchedName = sData.studentName || sData.name || '';
            fetchedClass = sData.studentClass || sData.class || '';

            if (currentLoggedInStudent) {
                currentLoggedInStudent.birthDate = studentBirthDate;
                if (fetchedName) currentLoggedInStudent.name = fetchedName;
                if (fetchedClass) currentLoggedInStudent.studentClass = fetchedClass;
                sessionStorage.setItem('studentLoggedInSession', JSON.stringify(currentLoggedInStudent));
            }
        }

        renderUnifiedProfile(scoreSnap, pointSnap, upperCode, studentBirthDate, fetchedName, fetchedClass);

    } catch (error) {
        console.error("Profile lookup error:", error);
    }
}
// --- UPDATED STUDENT PROFILE & DROPDOWN SCORE FILTER LOGIC ---
function renderUnifiedProfile(scoreSnap, pointSnap, upperCode, studentBirthDate, fetchedName, fetchedClass) {
    let studentName = fetchedName || "";
    let studentClass = "";
    let totalBehaviorPoints = 0;

    // 1. Process Behavior Points into Modern Activity Cards
    const behaviorFeed = document.getElementById('behaviorActivityFeed');
    if (behaviorFeed) behaviorFeed.innerHTML = "";

    const formatTimestamp = (raw) => {
        if (!raw) return 'Recent Event';
        try {
            let d;
            if (typeof raw.toDate === 'function') {
                d = raw.toDate();
            } else if (raw.seconds) {
                d = new Date(raw.seconds * 1000);
            } else if (typeof raw === 'string' || typeof raw === 'number') {
                d = new Date(raw);
            } else {
                d = new Date(raw);
            }
            if (isNaN(d.getTime())) return 'Recent Event';
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        } catch (e) {
            return 'Recent Event';
        }
    };

    if (!pointSnap.empty) {
        pointSnap.forEach((docSnap) => {
            const data = docSnap.data();
            if (!studentName && data.studentName) studentName = data.studentName;
            if (!studentClass && data.studentClass) studentClass = data.studentClass;

            const pts = parseFloat(data.points) || 0;
            totalBehaviorPoints += pts;

            const isPositive = pts > 0;
            const isNeutral = pts === 0;

            const badgeBg = isPositive ? 'rgba(16, 185, 129, 0.12)' : (isNeutral ? 'rgba(100, 116, 139, 0.12)' : 'rgba(239, 68, 68, 0.12)');
            const badgeColor = isPositive ? '#10b981' : (isNeutral ? '#64748b' : '#ef4444');
            const badgeBorder = isPositive ? 'rgba(16, 185, 129, 0.3)' : (isNeutral ? 'rgba(100, 116, 139, 0.3)' : 'rgba(239, 68, 68, 0.3)');
            const sign = isPositive ? '+' : '';

            // Icon SVG based on Merit vs Demerit
            const iconSvg = isPositive
                ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`
                : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>`;

            if (behaviorFeed) {
                behaviorFeed.innerHTML += `
                    <div class="behavior-activity-item">
                        <div class="behavior-item-left">
                            <div class="behavior-item-icon" style="background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder};">
                                ${iconSvg}
                            </div>
                            <div class="behavior-item-details">
                                <h4 class="behavior-item-title">${data.reason || 'Point Adjustment'}</h4>
                                <p class="behavior-item-date">${formatTimestamp(data.timestamp)}</p>
                            </div>
                        </div>

                        <div class="behavior-item-badge" style="background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder};">
                            ${sign}${pts} pts
                        </div>
                    </div>
                `;
            }
        });
    } else {
        if (behaviorFeed) {
            behaviorFeed.innerHTML = `<div style="text-align:center; color:var(--text-gray); padding: 32px 16px; background: var(--card-bg); border-radius: 12px; border: 1px dashed var(--border-color); font-size: 13.5px;">No behavior point records logged yet.</div>`;
        }
    }

    // 2. Process student name & class and cache exam scores
    cachedExamScores = [];
    if (!scoreSnap.empty) {
        scoreSnap.forEach((doc) => {
            const data = doc.data();
            cachedExamScores.push({ id: doc.id, ...data });
            if (!studentName && data.studentName) studentName = data.studentName;
            if (!studentClass && data.studentClass) studentClass = data.studentClass;
        });
    }

    // 3. Update Banner Headers & Behavior Badge
    const displayName = studentName || (currentLoggedInStudent ? currentLoggedInStudent.name : "Student Profile");
    const displayClass = studentClass || (currentLoggedInStudent ? currentLoggedInStudent.studentClass : 'Unassigned');

    const nameDisp = document.getElementById('studentNameDisplay');
    if (nameDisp) nameDisp.innerText = displayName;
    
    const classDisp = document.getElementById('studentClassDisplay');
    if (classDisp) classDisp.innerText = `Class: ${displayClass}`;

    const finalBirthDate = studentBirthDate || (currentLoggedInStudent ? currentLoggedInStudent.birthDate : '');

    // Update Greeting Banner with birthday check & Sidebar Profile
    updateGreetingBanner(displayName, finalBirthDate);

    const sidebarNameEl = document.getElementById('sidebarStudentName');
    if (sidebarNameEl) sidebarNameEl.innerText = displayName;

    const sidebarClassEl = document.getElementById('sidebarStudentClass');
    if (sidebarClassEl) sidebarClassEl.innerText = `Class: ${displayClass}`;

    const heroBadge = document.getElementById('heroTotalPoints');
    if (heroBadge) {
        heroBadge.innerText = (totalBehaviorPoints > 0 ? '+' : '') + totalBehaviorPoints;
        heroBadge.style.color = totalBehaviorPoints >= 0 ? '#10b981' : '#f87171';
    }

    const profileCard = document.getElementById('profileResultCard');
    if (profileCard) profileCard.classList.remove('hidden');
}

function renderExamScoresTable(filterValue) {
    const scoresTbody = document.getElementById('scoresTbody');
    scoresTbody.innerHTML = "";

    // 1. Default State: Prompt student to choose a quiz first
    if (!filterValue) {
        scoresTbody.innerHTML = `
            <tr>
                <td colspan="3" style="text-align:center; color:var(--text-gray); padding: 24px 12px; font-style: italic;">
                    Please select a quiz from the dropdown menu above to view your score.
                </td>
            </tr>`;
        return;
    }

    // 2. Filter scores by selected quiz title
    const filtered = cachedExamScores.filter(s => 
        s.examName === filterValue || 
        s.quizName === filterValue
    );

    if (filtered.length === 0) {
        scoresTbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-gray); padding: 20px;">No score recorded for the selected quiz.</td></tr>`;
        return;
    }

    // 3. Render row with enlarged, highlighted score badge
   filtered.forEach(data => {
    scoresTbody.innerHTML += `
        <tr>
            <td style="vertical-align: middle;"><strong>${data.examName || data.quizName || 'N/A'}</strong></td>
            <td style="vertical-align: middle; color: var(--text-gray); white-space: nowrap;">${data.subject || 'N/A'}</td>
            <td style="text-align: right; vertical-align: middle;">
                <span style="display: inline-block; white-space: nowrap; background: #ecfdf5; color: #10b981; font-size: 24px; font-weight: 800; padding: 4px 16px; border-radius: 8px; border: 1px solid #a7f3d0;">
                    ${data.score}
                </span>
            </td>
        </tr>
    `;
});
}

// Dropdown change listener
document.getElementById('examScoreDropdown')?.addEventListener('change', (e) => {
    renderExamScoresTable(e.target.value);
});

// --- UPDATED REAL-TIME SCHOOL NOTICES LISTENER ---
function loadNewsTicker() {
    try {
        const newsRef = collection(db, "news_updates");

        onSnapshot(newsRef, (querySnapshot) => {
            const newsListContainer = document.getElementById('newsListContainer');
            if (!newsListContainer) return;

            let studentClass = '';
            if (currentLoggedInStudent && currentLoggedInStudent.studentClass) {
                studentClass = currentLoggedInStudent.studentClass.trim();
            }

            if (querySnapshot.empty) {
                newsListContainer.innerHTML = "<p style='color: var(--text-gray); font-size: 13px; text-align: center; padding: 20px 0;'>No active school notices available.</p>";
                return;
            }

            let newsItems = [];
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                if (!data.status || data.status === 'active') {
                    const target = data.targetClasses;
                    const isTargeted = !target || 
                                       !Array.isArray(target) || 
                                       target.length === 0 || 
                                       target.includes('all') || 
                                       (studentClass && target.includes(studentClass));

                    if (isTargeted) {
                        newsItems.push(data);
                    }
                }
            });

            newsItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            newsListContainer.innerHTML = "";
            if (newsItems.length === 0) {
                newsListContainer.innerHTML = "<p style='color: var(--text-gray); font-size: 13px; text-align: center; padding: 20px 0;'>No active school notices available for your class.</p>";
                return;
            }

            newsItems.forEach(news => {
                const dateObj = new Date(news.timestamp);
                const month = dateObj.toLocaleString('default', { month: 'short' }).toUpperCase();
                const day = dateObj.getDate();
                const dateTag = `${month} ${day}`;

                const targetBadge = (news.targetClasses && !news.targetClasses.includes('all')) 
                    ? `<span style="font-size: 11px; background: rgba(30, 94, 255, 0.1); color: var(--primary-blue); padding: 2px 8px; border-radius: 6px; font-weight: 600; margin-left: 8px;">Class: ${news.targetClasses.join(', ')}</span>`
                    : '';

                newsListContainer.innerHTML += `
                    <div class="notice-card">
                        <div class="notice-header">
                            <h4 class="notice-title">${news.title} ${targetBadge}</h4>
                            <span class="notice-date-tag">${dateTag}</span>
                        </div>
                        <div class="notice-body">${news.content}</div>
                    </div>
                `;
            });
        });

    } catch (error) {
        console.error("Error pulling news ticker data:", error);
    }
}

function getTimeBasedGreeting(displayName) {
    const hour = new Date().getHours();
    let timeGreeting = "Good morning";
    if (hour >= 12 && hour < 17) {
        timeGreeting = "Good afternoon";
    } else if (hour >= 17 || hour < 5) {
        timeGreeting = "Good evening";
    }
    const namePart = displayName ? displayName.trim().split(' ')[0] : 'Student';
    return `${timeGreeting}, ${namePart} 👋`;
}

export function isTodayBirthday(birthDate) {
    if (!birthDate) return false;
    const today = new Date();
    const curMonth = today.getMonth(); // 0-indexed: 0-11
    const curDate = today.getDate(); // 1-31

    // 1. Standard ISO: YYYY-MM-DD
    if (typeof birthDate === 'string') {
        const trimmed = birthDate.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            const parts = trimmed.split('-');
            const m = parseInt(parts[1], 10) - 1;
            const d = parseInt(parts[2], 10);
            return m === curMonth && d === curDate;
        }
        // DD/MM/YYYY or DD-MM-YYYY
        const ddmmyyyy = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (ddmmyyyy) {
            const d = parseInt(ddmmyyyy[1], 10);
            const m = parseInt(ddmmyyyy[2], 10) - 1;
            return m === curMonth && d === curDate;
        }
    }

    // 2. Parseable Date string, Firestore Timestamp, or Date object
    try {
        let dateObj;
        if (typeof birthDate.toDate === 'function') {
            dateObj = birthDate.toDate();
        } else if (birthDate.seconds) {
            dateObj = new Date(birthDate.seconds * 1000);
        } else {
            dateObj = new Date(birthDate);
        }
        if (!isNaN(dateObj.getTime())) {
            return dateObj.getMonth() === curMonth && dateObj.getDate() === curDate;
        }
    } catch (e) {
        // ignore
    }
    return false;
}

let birthdayConfettiTriggered = false;

function launchBirthdayConfetti() {
    if (birthdayConfettiTriggered) return;
    birthdayConfettiTriggered = true;

    try {
        const canvas = document.createElement('canvas');
        canvas.id = 'birthdayConfettiCanvas';
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '999999';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        let width = canvas.width = window.innerWidth;
        let height = canvas.height = window.innerHeight;

        const colors = ['#f43f5e', '#ec4899', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#fbbf24'];
        const particles = Array.from({ length: 70 }, () => ({
            x: Math.random() * width,
            y: Math.random() * (height * 0.4) - 20,
            size: Math.random() * 8 + 4,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: Math.random() * 4 - 2,
            vy: Math.random() * 3 + 2,
            rot: Math.random() * 360,
            rotSpeed: Math.random() * 6 - 3,
            opacity: 1
        }));

        let startTime = Date.now();
        function animate() {
            const elapsed = Date.now() - startTime;
            ctx.clearRect(0, 0, width, height);

            let allDead = true;
            particles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.rot += p.rotSpeed;
                if (elapsed > 2500) {
                    p.opacity = Math.max(0, p.opacity - 0.02);
                }
                if (p.opacity > 0 && p.y < height) {
                    allDead = false;
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate((p.rot * Math.PI) / 180);
                    ctx.globalAlpha = p.opacity;
                    ctx.fillStyle = p.color;
                    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                    ctx.restore();
                }
            });

            if (!allDead && elapsed < 5000) {
                requestAnimationFrame(animate);
            } else {
                canvas.remove();
            }
        }
        requestAnimationFrame(animate);
    } catch (e) {
        console.warn('Birthday confetti skipped:', e);
    }
}

function updateGreetingBanner(displayName, birthDate) {
    const greetingEl = document.querySelector('.greeting-title');
    const subtitleEl = document.querySelector('.greeting-subtitle');
    const bannerEl = document.querySelector('.student-greeting-banner');
    if (!greetingEl) return;

    const namePart = displayName ? displayName.trim().split(' ')[0] : 'Student';
    const isBirthday = isTodayBirthday(birthDate);

    if (isBirthday) {
        greetingEl.innerHTML = `Happy Blessed Birthday to you, ${escapeHtml(namePart)} 🎂🎉`;
        if (subtitleEl) {
            subtitleEl.innerText = "Wishing you a joyful, blessed, and wonderful day! ✨🎈";
        }
        if (bannerEl) {
            bannerEl.classList.add('birthday-active');
        }
        launchBirthdayConfetti();
    } else {
        greetingEl.innerText = getTimeBasedGreeting(displayName);
        if (subtitleEl) {
            subtitleEl.innerText = "Here’s what’s happening today.";
        }
        if (bannerEl) {
            bannerEl.classList.remove('birthday-active');
        }
    }
}

// Initialize on load
updateGreetingBanner();
checkStudentSession();
loadNewsTicker();

// ======================================================
// STUDENT LIVE ATTENDANCE CALL & SELF-MARKING SYSTEM
// ======================================================

let activeStudentSessionDoc = null;
let studentAttendanceRecordUnsub = null;

function listenActiveStudentAttendance() {
    if (!currentLoggedInStudent) return;

    const banner = document.getElementById('studentAttendanceBanner');
    if (!banner) return;

    try {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const todayStr = `${yyyy}-${mm}-${dd}`;

        const studentClass = (currentLoggedInStudent.studentClass || '').trim();

        // Listen for active sessions today
        const sessionQuery = query(
            collection(db, "attendance_sessions"),
            where("date", "==", todayStr),
            where("status", "==", "active")
        );

        onSnapshot(sessionQuery, (snapshot) => {
            let matchingSession = null;

            snapshot.forEach(docSnap => {
                const sessionData = docSnap.data();
                const target = (sessionData.targetClass || '').trim();
                if (target === studentClass || target === "All Classes" || target === "all" || !target) {
                    matchingSession = { id: docSnap.id, ...sessionData };
                }
            });

            if (!matchingSession) {
                banner.classList.add('hidden');
                activeStudentSessionDoc = null;
                if (studentAttendanceRecordUnsub) {
                    studentAttendanceRecordUnsub();
                    studentAttendanceRecordUnsub = null;
                }
                return;
            }

            // Session exists for student's class
            activeStudentSessionDoc = matchingSession;
            banner.classList.remove('hidden');

            const subjBadge = document.getElementById('attStudentSessionSubjectBadge');
            const titleEl = document.getElementById('attStudentSessionTitle');
            const subTitleEl = document.getElementById('attStudentSessionSubtitle');

            if (subjBadge) subjBadge.innerText = matchingSession.subject || 'Class';
            if (titleEl) titleEl.innerText = matchingSession.sessionTitle || `${matchingSession.subject} Attendance Call`;
            if (subTitleEl) subTitleEl.innerText = `Teacher ${matchingSession.teacherName || ''} deployed attendance for Class ${matchingSession.targetClass}. Please mark your status below.`;

            // Listen to student's record for this session
            const recordDocId = `${matchingSession.date}_${matchingSession.subject.replace(/\s+/g, '_')}_${currentLoggedInStudent.code}`;
            const recordDocRef = doc(db, "attendance_records", recordDocId);

            if (studentAttendanceRecordUnsub) {
                studentAttendanceRecordUnsub();
            }

            studentAttendanceRecordUnsub = onSnapshot(recordDocRef, (recSnap) => {
                const formContainer = document.getElementById('attStudentFormContainer');
                const submittedCard = document.getElementById('attStudentSubmittedCard');
                const statusText = document.getElementById('attSubmittedStatusText');
                const timeText = document.getElementById('attSubmittedTimeText');
                const iconEl = document.getElementById('attSubmittedIcon');

                if (recSnap.exists()) {
                    const rec = recSnap.data();
                    if (formContainer) formContainer.classList.add('hidden');
                    if (submittedCard) submittedCard.classList.remove('hidden');

                    let statusLabel = 'Present';
                    let statusColor = '#10b981';
                    let iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><polyline points="16 11 18 13 22 9"></polyline></svg>';

                    if (rec.status === 'present') {
                        statusLabel = 'Present (Hadir)';
                        statusColor = '#10b981';
                        iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><polyline points="16 11 18 13 22 9"></polyline></svg>';
                    } else if (rec.status === 'absent') {
                        statusLabel = 'Absent (Tidak Hadir)';
                        statusColor = '#ef4444';
                        iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="17" y1="8" x2="22" y2="13"></line><line x1="22" y1="8" x2="17" y2="13"></line></svg>';
                    } else if (rec.status === 'others') {
                        statusLabel = `Others: ${rec.reason || 'Reason Provided'}`;
                        statusColor = '#f59e0b';
                        iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';
                    }

                    if (statusText) statusText.innerText = `Status: ${statusLabel}`;
                    if (timeText && rec.timestamp) {
                        const t = new Date(rec.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        timeText.innerText = `Recorded at ${t} (${rec.markedBy === 'teacher' ? 'Marked by Teacher' : 'Self-Marked'})`;
                    }
                    if (iconEl) {
                        iconEl.innerHTML = iconSvg;
                        iconEl.style.color = statusColor;
                    }
                } else {
                    if (formContainer) formContainer.classList.remove('hidden');
                    if (submittedCard) submittedCard.classList.add('hidden');
                }
            });

        }, (err) => {
            console.error("Error listening to student attendance sessions:", err);
        });

    } catch (e) {
        console.error("Student attendance listener setup error:", e);
    }
}

// Handle radio choice change for reason box toggle
document.querySelectorAll('input[name="studentAttStatus"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const reasonWrapper = document.getElementById('attStudentReasonWrapper');
        if (reasonWrapper) {
            if (e.target.value === 'others') {
                reasonWrapper.classList.remove('hidden');
            } else {
                reasonWrapper.classList.add('hidden');
            }
        }
    });
});

// Handle "Change Status" button
document.getElementById('btnEditStudentAttendance')?.addEventListener('click', () => {
    document.getElementById('attStudentFormContainer')?.classList.remove('hidden');
    document.getElementById('attStudentSubmittedCard')?.classList.add('hidden');
});

// Handle Student Attendance Submit
document.getElementById('btnSubmitStudentAttendance')?.addEventListener('click', async () => {
    if (!currentLoggedInStudent || !activeStudentSessionDoc) {
        alert("No active attendance session found or you are not logged in.");
        return;
    }

    const selectedRadio = document.querySelector('input[name="studentAttStatus"]:checked');
    const status = selectedRadio ? selectedRadio.value : 'present';
    const reasonInput = document.getElementById('attStudentReasonInput');
    const reason = reasonInput ? reasonInput.value.trim() : '';

    if (status === 'others' && !reason) {
        alert("Please provide a reason for 'Others' (e.g. Sakit Flu, Izin Dokter, dll).");
        reasonInput?.focus();
        return;
    }

    const submitBtn = document.getElementById('btnSubmitStudentAttendance');
    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = "Submitting...";
        }

        const date = activeStudentSessionDoc.date;
        const subject = activeStudentSessionDoc.subject;
        const recordDocId = `${date}_${subject.replace(/\s+/g, '_')}_${currentLoggedInStudent.code}`;

        await setDoc(doc(db, "attendance_records", recordDocId), {
            sessionId: activeStudentSessionDoc.id,
            date: date,
            subject: subject,
            studentCode: currentLoggedInStudent.code,
            studentName: currentLoggedInStudent.name,
            studentClass: currentLoggedInStudent.studentClass,
            status: status,
            reason: reason,
            timestamp: new Date().toISOString(),
            markedBy: 'student'
        }, { merge: true });

        alert(`Attendance Submitted!\nYou have marked: ${status.toUpperCase()} for ${subject}.`);

    } catch (err) {
        console.error("Error saving student attendance:", err);
        alert("Failed to submit attendance: " + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<span>Submit Attendance</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
        }
    }
});

// ===============================================
// --- STUDENT ASSIGNMENT REMINDER SYSTEM ---
// ===============================================

function getReminderDaysLate(dueDateStr) {
    if (!dueDateStr) return 0;
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const parts = dueDateStr.split('-');
        if (parts.length !== 3) return 0;
        const due = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        const diffMs = today.getTime() - due.getTime();
        return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    } catch (e) {
        return 0;
    }
}

function listenStudentAssignmentReminders(studentCode) {
    if (studentReminderUnsubscribe) {
        studentReminderUnsubscribe();
        studentReminderUnsubscribe = null;
    }

    if (!studentCode) return;
    const upperCode = studentCode.toString().trim().toUpperCase();

    const reminderCard = document.getElementById('studentAssignmentReminderCard');
    const container = document.getElementById('studentReminderListContainer');
    const headerCount = document.getElementById('studentReminderHeaderCount');

    try {
        // Query by studentCode alone to avoid requiring composite indexes in Firestore
        const q = query(
            collection(db, "assignment_reminders"),
            where("studentCode", "==", upperCode)
        );

        studentReminderUnsubscribe = onSnapshot(q, (snapshot) => {
            const reminders = [];
            snapshot.forEach(docSnap => {
                const d = docSnap.data();
                if ((d.status || 'pending').toLowerCase() === 'pending') {
                    reminders.push({
                        id: docSnap.id,
                        ...d
                    });
                }
            });

            if (reminders.length === 0) {
                if (reminderCard) reminderCard.style.display = 'none';
                return;
            }

            // Sort: Most overdue first, then upcoming
            reminders.sort((a, b) => {
                const lateA = getReminderDaysLate(a.dueDate);
                const lateB = getReminderDaysLate(b.dueDate);
                return lateB - lateA;
            });

            if (headerCount) {
                headerCount.style.display = 'none';
            }

            if (container) {
                let html = '';
                reminders.forEach(r => {
                    const daysLate = getReminderDaysLate(r.dueDate);
                    let lateTierClass = '';
                    let lateBadgeHtml = '';

                    // Date display formatting
                    let formattedDueDate = r.dueDate || 'No due date';
                    try {
                        const parts = r.dueDate.split('-');
                        if (parts.length === 3) {
                            const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                            formattedDueDate = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                        }
                    } catch (e) {}

                    if (daysLate >= 3) {
                        // 3+ days late: Aggressive shake, flashing red text, neon border
                        lateTierClass = 'reminder-late-critical';
                        lateBadgeHtml = `
                            <div class="reminder-badge-critical">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" class="reminder-badge-fire">
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                                    <line x1="12" y1="9" x2="12" y2="13"></line>
                                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                                </svg>
                                <span class="reminder-late-text-animated">CRITICAL: ${daysLate} DAYS LATE!</span>
                            </div>
                        `;
                    } else if (daysLate === 2) {
                        // 2 days late: Energetic vibration and red alert
                        lateTierClass = 'reminder-late-2days';
                        lateBadgeHtml = `
                            <div class="reminder-badge-2days">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                                    <line x1="12" y1="9" x2="12" y2="13"></line>
                                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                                </svg>
                                <span class="reminder-late-text-animated">2 DAYS LATE!</span>
                            </div>
                        `;
                    } else if (daysLate === 1) {
                        // 1 day late: Mild animation / gentle amber-orange pulse
                        lateTierClass = 'reminder-late-1day';
                        lateBadgeHtml = `
                            <div class="reminder-badge-1day">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="12" y1="8" x2="12" y2="12"></line>
                                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                                </svg>
                                <span>Late by 1 day</span>
                            </div>
                        `;
                    } else if (daysLate === 0) {
                        // Due today
                        lateTierClass = 'reminder-due-today';
                        lateBadgeHtml = `
                            <div class="reminder-badge-today">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <polyline points="12 6 12 12 16 14"></polyline>
                                </svg>
                                <span>Due Today</span>
                            </div>
                        `;
                    } else {
                        // Upcoming
                        const daysLeft = Math.abs(daysLate);
                        lateTierClass = 'reminder-due-future';
                        lateBadgeHtml = `
                            <div class="reminder-badge-future">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                    <line x1="16" y1="2" x2="16" y2="6"></line>
                                    <line x1="8" y1="2" x2="8" y2="6"></line>
                                    <line x1="3" y1="10" x2="21" y2="10"></line>
                                </svg>
                                <span>Due in ${daysLeft} day${daysLeft > 1 ? 's' : ''}</span>
                            </div>
                        `;
                    }

                    html += `
                        <div class="student-reminder-item ${lateTierClass}">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
                                <span class="reminder-subject-tag">${escapeHtml(r.subject || 'Subject')}</span>
                                ${lateBadgeHtml}
                            </div>
                            <h4 class="reminder-assignment-title">${escapeHtml(r.assignmentTitle || 'Assignment')}</h4>
                            <div class="reminder-due-row">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <polyline points="12 6 12 12 16 14"></polyline>
                                </svg>
                                <span>Due: <strong>${escapeHtml(formattedDueDate)}</strong></span>
                            </div>
                            ${r.notes ? `
                                <div class="reminder-notes-text">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; margin-top: 1px;">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                        <polyline points="14 2 14 8 20 8"></polyline>
                                        <line x1="16" y1="13" x2="8" y2="13"></line>
                                        <line x1="16" y1="17" x2="8" y2="17"></line>
                                        <polyline points="10 9 9 9 8 9"></polyline>
                                    </svg>
                                    <span>${escapeHtml(r.notes)}</span>
                                </div>` : ''}
                        </div>
                    `;
                });

                container.innerHTML = html;
            }

            if (reminderCard) reminderCard.style.display = 'block';

        }, (err) => {
            console.error("Student assignment reminders listener error:", err);
        });

    } catch (e) {
        console.error("Could not setup student assignment reminders:", e);
    }
}