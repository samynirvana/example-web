import { doc, getDoc, getDocs, collection, addDoc, deleteDoc, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml, triggerCelebration, attachRippleEffect } from "./utils.js";

let currentStudent = null;
let activeQuiz = null;
let availableQuizzesMap = {};
let recentQuizResults = [];
let currentReviewedQuiz = null;

// --- THEME TOGGLE SYSTEM ---
const themeToggleBtn = document.getElementById('themeToggleBtn');
const savedTheme = localStorage.getItem('appTheme') || 'light';

function applyQuizTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);
    document.body.classList.toggle('dark-mode', isDark);
    document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
    document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
}

applyQuizTheme(savedTheme);

themeToggleBtn?.addEventListener('click', () => {
    const isDark = !document.body.classList.contains('dark-theme');
    const newTheme = isDark ? 'dark' : 'light';
    localStorage.setItem('appTheme', newTheme);
    localStorage.setItem('theme', newTheme);
    applyQuizTheme(newTheme);
});

document.getElementById('studentLogoutBtn')?.addEventListener('click', () => {
    sessionStorage.removeItem('studentLoggedInSession');
    sessionStorage.removeItem('studentTimelineSession');
    window.location.href = 'index.html';
});

// --- HELPER: RESOLVE SUBJECT ---
function resolveSubject(rawSubject, title) {
    const s = (rawSubject || '').toString().trim();
    if (s && s.toLowerCase() !== 'general' && s.toLowerCase() !== 'n/a' && s.toLowerCase() !== 'unknown') {
        return s;
    }
    const t = (title || '').toLowerCase();
    if (t.includes('ict') || t.includes('computer') || t.includes('tech') || t.includes('code') || t.includes('python')) return 'ICT';
    if (t.includes('math') || t.includes('algebra') || t.includes('calc')) return 'Mathematics';
    if (t.includes('bio') || t.includes('science') || t.includes('chem') || t.includes('physic')) return 'Science';
    if (t.includes('eng') || t.includes('read') || t.includes('gram') || t.includes('vocab')) return 'English';
    return 'General';
}

function getSubjectClass(subject) {
    const s = (subject || '').toLowerCase();
    if (s.includes('math')) return 'math';
    if (s.includes('sci') || s.includes('bio') || s.includes('chem')) return 'science';
    if (s.includes('eng')) return 'english';
    if (s.includes('ict') || s.includes('comp')) return 'ict';
    return 'general';
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return 'Recently';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return 'Recently';
        return d.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }) + ' • ' + d.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return 'Recently';
    }
}

// --- INITIALIZE ON PAGE LOAD ---
window.addEventListener('DOMContentLoaded', async () => {
    const savedLoggedIn = sessionStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession');
    let code = '';

    if (savedLoggedIn) {
        try {
            const session = JSON.parse(savedLoggedIn);
            code = (session.code || session.studentCode || session.id || '').trim().toUpperCase();
        } catch (e) {
            console.error("Session parse error:", e);
        }
    }

    if (!code) {
        code = (localStorage.getItem('loggedInStudentCode') || '').trim().toUpperCase();
    }

    // Students must be logged in to access quizzes and can only take quizzes for themselves
    if (!code) {
        window.location.href = "index.html";
        return;
    }

    await initStudentQuizDashboard(code);
});

// --- HELPER FUNCTIONS FOR STUDENT PROFILE ---
// Convert Google Drive share link to high-res direct embed URL
function resolvePhotoUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith('https://lh3.googleusercontent.com/d/') || trimmed.startsWith('data:image/')) {
        return trimmed;
    }
    const driveMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/) || trimmed.match(/id=([a-zA-Z0-9_-]+)/);
    if (driveMatch && driveMatch[1]) {
        return `https://lh3.googleusercontent.com/d/${driveMatch[1]}`;
    }
    return trimmed;
}

// Extract student nickname (checks nickname field or uses first name)
function getStudentNickname(studentObj) {
    if (!studentObj) return 'Student';
    const explicit = (studentObj.nickname || studentObj.nickName || studentObj.shortName || '').trim();
    if (explicit) return explicit;

    const full = (studentObj.studentName || studentObj.name || '').trim();
    if (!full) return 'Student';
    if (full.toLowerCase() === 'administrator') return 'Administrator';
    const parts = full.split(/\s+/);
    return parts[0] || full;
}

// --- INIT STUDENT DASHBOARD ---
async function initStudentQuizDashboard(code) {
    try {
        const snap = await getDoc(doc(db, "students", code));
        if (!snap.exists()) {
            console.warn(`Student Code "${code}" not found.`);
            window.location.href = "index.html";
            return;
        }

        const data = snap.data();
        currentStudent = { code, ...data };

        // Check sessionStorage cache for photo if not in current doc
        let cachedPhoto = '';
        const rawSession = sessionStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession');
        if (rawSession) {
            try {
                const sess = JSON.parse(rawSession);
                cachedPhoto = sess.photoUrl || sess.photo || sess.avatar || '';
            } catch (e) { }
        }

        // Render Student Identity Banner with nickname only
        const studentName = currentStudent.studentName || currentStudent.name || 'Student';
        const nickname = getStudentNickname(currentStudent);
        const studentClass = currentStudent.studentClass || currentStudent.class || 'Unassigned';
        const initial = (nickname || studentName).charAt(0).toUpperCase() || 'S';

        // Synchronize photo with database
        const rawPhoto = currentStudent.photoUrl || currentStudent.photo || currentStudent.avatar || cachedPhoto || '';
        const photoUrl = resolvePhotoUrl(rawPhoto);

        const dashPhoto = document.getElementById('dashStudentPhoto');
        const dashInitial = document.getElementById('dashStudentInitial');

        if (photoUrl && dashPhoto) {
            dashPhoto.src = photoUrl;
            dashPhoto.classList.remove('hidden');
            if (dashInitial) dashInitial.classList.add('hidden');
            dashPhoto.onerror = () => {
                dashPhoto.classList.add('hidden');
                if (dashInitial) {
                    dashInitial.innerText = initial;
                    dashInitial.classList.remove('hidden');
                }
            };
        } else {
            if (dashPhoto) dashPhoto.classList.add('hidden');
            if (dashInitial) {
                dashInitial.innerText = initial;
                dashInitial.classList.remove('hidden');
            }
        }

        // Set nickname in greeting
        const dashName = document.getElementById('dashStudentName');
        if (dashName) dashName.innerText = nickname;

        const modalClass = document.getElementById('modalStudentClass');
        if (modalClass) modalClass.innerText = studentClass;

        // Display dashboard
        document.getElementById('quizDashboardSection')?.classList.remove('hidden');
        document.getElementById('takeQuizSection')?.classList.add('hidden');
        document.getElementById('resultSection')?.classList.add('hidden');

        // Sequentially load recent quizzes first so recentQuizResults is ready for completion checks
        await loadRecentQuizzes(code);
        await loadAvailableQuizzes(studentClass);

    } catch (err) {
        console.error("Dashboard initialization error:", err);
    }
}

// --- LOAD RECENT QUIZZES (ONLINE QUIZZES CREATED ON WEBSITE ONLY) ---
async function loadRecentQuizzes(studentCode) {
    const container = document.getElementById('recentQuizzesContainer');
    const badge = document.getElementById('recentQuizCountBadge');
    if (!container) return;

    container.innerHTML = `
        <div class="quiz-empty-box">
            <div class="quiz-empty-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
            </div>
            <p style="margin:0; font-size:14px; font-weight:600; color:var(--text-gray);">Loading your recent online quizzes...</p>
        </div>
    `;

    try {
        const resultsMap = new Map();

        // Query only online quiz results submitted via the website (quiz_results collection)
        // Does NOT query exam_scores (offline or classroom exams)
        try {
            const qSnap = await getDocs(query(collection(db, "quiz_results"), where("studentCode", "==", studentCode)));
            qSnap.forEach(docSnap => {
                const d = docSnap.data();
                const key = (d.quizId || d.quizTitle || docSnap.id).trim().toLowerCase();
                resultsMap.set(key, {
                    id: docSnap.id,
                    quizId: d.quizId || null,
                    quizTitle: d.quizTitle || "Online Quiz",
                    subject: resolveSubject(d.subject, d.quizTitle),
                    score: d.score !== undefined ? d.score : 0,
                    totalAutoGradable: d.totalAutoGradable || d.totalPoints || 0,
                    responses: d.responses || [],
                    submittedAt: d.submittedAt || null,
                    source: 'quiz_results'
                });
            });
        } catch (e) {
            console.warn("quiz_results query error:", e);
        }

        recentQuizResults = Array.from(resultsMap.values());

        // Sort chronologically descending (newest first)
        recentQuizResults.sort((a, b) => {
            const tA = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
            const tB = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
            return tB - tA;
        });

        if (badge) badge.innerText = recentQuizResults.length;

        if (recentQuizResults.length === 0) {
            container.innerHTML = `
                <div class="quiz-empty-box">
                    <div class="quiz-empty-icon">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <line x1="16" y1="13" x2="8" y2="13"></line>
                            <line x1="16" y1="17" x2="8" y2="17"></line>
                        </svg>
                    </div>
                    <h4 style="margin: 0; font-size: 16.5px; font-weight: 800; color: var(--text-dark);">No Quizzes Completed Yet</h4>
                    <p style="margin: 0; font-size: 13px; color: var(--text-gray); max-width: 400px; line-height: 1.5;">
                        You haven't completed any online quizzes so far. Click the <strong>Start Quiz</strong> button below to take your first test!
                    </p>
                </div>
            `;
            return;
        }

        // Render Recent Quiz Cards
        container.innerHTML = "";
        recentQuizResults.forEach((quiz, idx) => {
            const card = document.createElement('div');
            card.className = 'recent-quiz-card';

            const subClass = getSubjectClass(quiz.subject);
            const total = quiz.totalAutoGradable || 10;
            const scoreNum = parseFloat(quiz.score) || 0;
            const percentage = total > 0 ? Math.round((scoreNum / total) * 100) : scoreNum;

            let scoreClass = 'score-good';
            if (percentage < 60) scoreClass = 'score-low';
            else if (percentage < 80) scoreClass = 'score-medium';

            const hasResponses = quiz.responses && quiz.responses.length > 0;

            card.innerHTML = `
                <div class="recent-quiz-info">
                    <div class="recent-quiz-header-row">
                        <span class="subject-badge ${subClass}">${escapeHtml(quiz.subject)}</span>
                        <span class="recent-quiz-date">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                            ${formatDateDisplay(quiz.submittedAt)}
                        </span>
                    </div>
                    <h3 class="recent-quiz-title">${escapeHtml(quiz.quizTitle)}</h3>
                </div>

                <div class="recent-quiz-stats">
                    <div class="recent-quiz-score-pill">
                        <div class="score-number-highlight ${scoreClass}">
                            ${scoreNum} <span style="font-size: 13px; font-weight: 600; opacity: 0.7;">/ ${total}</span>
                        </div>
                        <span class="score-percentage-label">${percentage}% Score</span>
                    </div>

                    <div>
                        ${hasResponses ? `
                            <button class="review-quiz-btn" data-index="${idx}" title="Review your quiz answers">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                    <circle cx="12" cy="12" r="3"></circle>
                                </svg>
                                <span>Review</span>
                            </button>
                        ` : `
                            <span style="font-size: 11.5px; font-weight: 700; color: #10b981; background: rgba(16, 185, 129, 0.1); padding: 4px 10px; border-radius: 8px;">
                                ✓ Recorded
                            </span>
                        `}
                    </div>
                </div>
            `;

            container.appendChild(card);
        });

        // Attach review button listeners
        container.querySelectorAll('.review-quiz-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                openQuizReviewModal(recentQuizResults[idx]);
            });
        });

    } catch (err) {
        console.error("Error loading recent quizzes:", err);
        container.innerHTML = `
            <div class="quiz-empty-box">
                <p style="margin:0; font-size:14px; color:#ef4444;">Failed to load recent quizzes. Please check your connection.</p>
            </div>
        `;
    }
}

// --- REVIEW MODAL HANDLER ---
function openQuizReviewModal(resultItem) {
    if (!resultItem) return;
    currentReviewedQuiz = resultItem;

    const modal = document.getElementById('quizReviewModal');
    const titleEl = document.getElementById('reviewQuizTitle');
    const badgeEl = document.getElementById('reviewScoreBadge');
    const listEl = document.getElementById('quizReviewQuestionsList');

    if (!modal || !listEl) return;

    if (titleEl) titleEl.innerText = resultItem.quizTitle || 'Quiz Review';
    if (badgeEl) {
        const total = resultItem.totalAutoGradable || (resultItem.responses ? resultItem.responses.length : 10);
        badgeEl.innerText = `Score: ${resultItem.score} / ${total}`;
    }

    listEl.innerHTML = '';
    const responses = resultItem.responses || [];

    if (responses.length === 0) {
        listEl.innerHTML = '<p style="text-align:center; color:var(--text-gray); padding: 20px;">Detailed question responses are not available for this record.</p>';
    } else {
        responses.forEach((resp, qIdx) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'review-question-item';

            let statusTag = '';
            if (resp.isEssay) {
                statusTag = `<span class="review-status-tag review-status-essay">✎ Written Response</span>`;
            } else if (resp.isCorrect) {
                statusTag = `<span class="review-status-tag review-status-correct">✓ Correct (+1)</span>`;
            } else {
                statusTag = `<span class="review-status-tag review-status-incorrect">✗ Incorrect</span>`;
            }

            itemDiv.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                    <span style="font-size: 13px; font-weight: 800; color: var(--primary-blue);">Question ${qIdx + 1}</span>
                    ${statusTag}
                </div>
                <div style="font-size: 14.5px; font-weight: 600; color: var(--text-dark); line-height: 1.5;">${escapeHtml(resp.prompt || '')}</div>
                <div style="font-size: 13.5px; margin-top: 4px; padding: 10px 12px; border-radius: 8px; background: rgba(15, 23, 42, 0.03); border: 1px solid var(--border-color);">
                    <span style="font-weight: 700; color: var(--text-gray);">Your Answer:</span>
                    <span style="font-weight: 600; color: ${resp.isCorrect ? '#10b981' : (resp.isEssay ? 'var(--text-dark)' : '#ef4444')}; margin-left: 6px;">
                        ${escapeHtml(resp.response || 'No answer')}
                    </span>
                </div>
                ${(!resp.isCorrect && !resp.isEssay && resp.expected) ? `
                    <div style="font-size: 12.5px; color: #10b981; font-weight: 600; padding: 4px 6px;">
                        Expected Answer: ${escapeHtml(resp.expected)}
                    </div>
                ` : ''}
            `;
            listEl.appendChild(itemDiv);
        });
    }

    modal.classList.remove('hidden');
}


// Close Review Modal Handlers
document.getElementById('closeReviewModalIconBtn')?.addEventListener('click', () => {
    document.getElementById('quizReviewModal')?.classList.add('hidden');
});
document.getElementById('closeReviewModalBtn')?.addEventListener('click', () => {
    document.getElementById('quizReviewModal')?.classList.add('hidden');
});
document.getElementById('quizReviewModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'quizReviewModal') {
        document.getElementById('quizReviewModal')?.classList.add('hidden');
    }
});

// Check if a student has already completed a specific quiz
function isQuizAlreadyCompleted(quiz) {
    if (!quiz || !Array.isArray(recentQuizResults) || recentQuizResults.length === 0) return false;
    const targetTitle = (quiz.title || '').trim().toLowerCase();
    const targetId = quiz.id ? String(quiz.id).trim() : '';

    return recentQuizResults.some(r => {
        if (targetId && r.quizId && String(r.quizId).trim() === targetId) return true;
        if (targetTitle && (r.quizTitle || '').trim().toLowerCase() === targetTitle) return true;
        return false;
    });
}

// --- LOAD AVAILABLE QUIZZES FOR CLASS ---
async function loadAvailableQuizzes(studentClass) {
    const listContainer = document.getElementById('availableQuizzesList');
    const ctaCount = document.getElementById('ctaAvailableQuizzesCount');
    if (!listContainer) return;

    availableQuizzesMap = {};

    try {
        const snap = await getDocs(collection(db, "quizzes"));
        let count = 0;
        const normalizedStudentClass = (studentClass || '').toLowerCase().trim();

        snap.forEach(docSnap => {
            const q = docSnap.data();
            const status = (q.status || 'active').toLowerCase().trim();

            if (status !== 'active') return;

            const targetClass = (q.targetClass || '').toLowerCase().trim();
            const targetClassesList = Array.isArray(q.targetClassesList) ? q.targetClassesList.map(c => c.toLowerCase().trim()) : [];

            const isMatch = targetClass === 'all' || 
                            targetClass === 'all classes' || 
                            targetClass === normalizedStudentClass ||
                            targetClassesList.includes('all') ||
                            targetClassesList.includes('all classes') ||
                            targetClassesList.includes(normalizedStudentClass) ||
                            targetClass.split(',').map(s => s.trim()).includes(normalizedStudentClass);

            if (isMatch) {
                const quizObj = { id: docSnap.id, ...q };
                availableQuizzesMap[docSnap.id] = quizObj;
                count++;
            }
        });

        // Calculate pending (not completed) vs completed quizzes
        const quizList = Object.values(availableQuizzesMap);
        const pendingQuizzes = quizList.filter(q => !isQuizAlreadyCompleted(q));
        const pendingCount = pendingQuizzes.length;
        const totalCount = quizList.length;

        if (ctaCount) {
            if (totalCount === 0) {
                ctaCount.innerText = "0 Quizzes Available";
            } else if (pendingCount === 0) {
                ctaCount.innerText = "All Quizzes Completed";
            } else {
                ctaCount.innerText = `${pendingCount} Active Quiz${pendingCount === 1 ? '' : 'zes'} Available`;
            }
        }

        const ctaCard = document.getElementById('startQuizCtaCard');
        if (ctaCard) {
            const headingEl = ctaCard.querySelector('.cta-heading');
            const btnEl = ctaCard.querySelector('.start-quiz-big-btn span');
            if (headingEl) {
                if (totalCount > 0 && pendingCount === 0) {
                    headingEl.innerText = "You're All Caught Up!";
                    if (btnEl) btnEl.innerText = "View Quizzes";
                } else if (totalCount === 0) {
                    headingEl.innerText = "No Quizzes Available";
                    if (btnEl) btnEl.innerText = "Check Quizzes";
                } else {
                    headingEl.innerText = "Ready for a Quiz?";
                    if (btnEl) btnEl.innerText = "Start Quiz";
                }
            }
        }

        // Render Cards inside the Available Quizzes Modal
        if (quizList.length === 0) {
            listContainer.innerHTML = `
                <div class="quiz-empty-box" style="padding: 30px 16px;">
                    <div class="quiz-empty-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 10"></polyline></svg>
                    </div>
                    <h4 style="margin:0; font-size:15px; font-weight:700; color:var(--text-dark);">No Quizzes Available</h4>
                    <p style="margin:0; font-size:13px; color:var(--text-gray);">There are currently no active quizzes assigned for class "${escapeHtml(studentClass)}". Please check back soon!</p>
                </div>
            `;
            return;
        }

        listContainer.innerHTML = '';
        quizList.forEach(quiz => {
            const card = document.createElement('div');
            const isCompleted = isQuizAlreadyCompleted(quiz);

            card.className = 'available-quiz-card' + (isCompleted ? ' is-completed' : '');
            card.setAttribute('data-id', quiz.id);

            const resolvedSub = resolveSubject(quiz.subject, quiz.title);
            const subClass = getSubjectClass(resolvedSub);
            const questions = quiz.items || quiz.questions || [];
            const qCount = questions.length;

            // Types preview
            const typesSet = new Set();
            questions.forEach(q => {
                if (q.type === 'mcq' || (!q.type && q.question)) typesSet.add('Multiple Choice');
                else if (q.type === 'fill') typesSet.add('Fill in Blank');
                else if (q.type === 'essay') typesSet.add('Essay');
                else if (q.type === 'matching') typesSet.add('Matching');
            });
            const typesText = typesSet.size > 0 ? Array.from(typesSet).slice(0, 2).join(' • ') : 'Standard Assessment';

            card.innerHTML = `
                <div class="avail-quiz-info">
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <span class="subject-badge ${subClass}">${escapeHtml(resolvedSub)}</span>
                        ${isCompleted ? `
                            <span style="font-size: 11.5px; font-weight: 700; color: #059669; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 2px 8px; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                Completed
                            </span>
                        ` : `
                            <span style="font-size: 12px; font-weight: 700; color: #10b981; background: rgba(16, 185, 129, 0.1); padding: 2px 7px; border-radius: 5px;">Active</span>
                        `}
                    </div>
                    <h3 class="avail-quiz-title">${escapeHtml(quiz.title || 'Untitled Quiz')}</h3>
                    <div class="avail-quiz-meta">
                        <span>📝 ${qCount} Questions</span>
                        <span>•</span>
                        <span>${escapeHtml(typesText)}</span>
                    </div>
                    ${isCompleted ? `
                        <div class="completed-quiz-notice">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                            <span>You've already did the quiz</span>
                        </div>
                    ` : ''}
                </div>

                ${isCompleted ? `
                    <button class="take-quiz-arrow-btn completed-btn" disabled title="You have already completed this quiz">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        <span>Done</span>
                    </button>
                ` : `
                    <button class="take-quiz-arrow-btn">
                        <span>Start</span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                            <polyline points="12 5 19 12 12 19"></polyline>
                        </svg>
                    </button>
                `}
            `;

            // Click card to start quiz only if not completed
            card.addEventListener('click', (e) => {
                if (isCompleted) {
                    e.preventDefault();
                    e.stopPropagation();
                    alert("You've already did the quiz. Each quiz can only be completed once.");
                    return;
                }
                startQuizById(quiz.id);
            });

            listContainer.appendChild(card);
        });

    } catch (err) {
        console.error("Error loading available quizzes:", err);
        listContainer.innerHTML = '<p style="color:#ef4444; padding:20px; text-align:center;">Failed to load available quizzes.</p>';
    }
}

// --- OPEN AVAILABLE QUIZZES POP-UP MODAL ---
document.getElementById('openAvailableQuizzesBtn')?.addEventListener('click', () => {
    document.getElementById('studentQuizModal')?.classList.remove('hidden');
});

// Close Modal Handlers
document.getElementById('closeModalIconBtn')?.addEventListener('click', () => {
    document.getElementById('studentQuizModal')?.classList.add('hidden');
});
document.getElementById('closeModalBtn')?.addEventListener('click', () => {
    document.getElementById('studentQuizModal')?.classList.add('hidden');
});
document.getElementById('studentQuizModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'studentQuizModal') {
        document.getElementById('studentQuizModal')?.classList.add('hidden');
    }
});

// --- START SELECTED QUIZ ---
function startQuizById(quizId) {
    if (!quizId || !availableQuizzesMap[quizId]) {
        alert("Please choose a valid quiz.");
        return;
    }

    const targetQuiz = availableQuizzesMap[quizId];
    if (isQuizAlreadyCompleted(targetQuiz)) {
        alert("You've already did the quiz. Each quiz can only be completed once.");
        return;
    }

    activeQuiz = targetQuiz;

    // Hide modals and dashboard, show assessment form
    document.getElementById('studentQuizModal')?.classList.add('hidden');
    document.getElementById('quizDashboardSection')?.classList.add('hidden');
    document.getElementById('takeQuizSection')?.classList.remove('hidden');

    renderQuizForm(activeQuiz);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Cancel / Exit Active Quiz
document.getElementById('cancelQuizBtn')?.addEventListener('click', () => {
    if (confirm("Are you sure you want to exit? Your answers for this assessment will not be saved.")) {
        document.getElementById('takeQuizSection')?.classList.add('hidden');
        document.getElementById('quizDashboardSection')?.classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
});

// Return to Dashboard from Result Screen
document.getElementById('returnToDashboardBtn')?.addEventListener('click', async () => {
    document.getElementById('resultSection')?.classList.add('hidden');
    document.getElementById('quizDashboardSection')?.classList.remove('hidden');
    if (currentStudent && currentStudent.code) {
        await loadRecentQuizzes(currentStudent.code);
        await loadAvailableQuizzes(currentStudent.studentClass || currentStudent.class);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Auto-resize input textareas to fit content without scrollbars
window.autoResizeInput = function(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(48, el.scrollHeight) + 'px';
};

// --- RENDER ASSESSMENT FORM ---
function renderQuizForm(quiz) {
    document.getElementById('activeQuizTitle').innerText = quiz.title;
    document.getElementById('activeQuizSubject').innerText = `Subject: ${quiz.subject || 'General'}`;

    const form = document.getElementById('quizForm');
    form.innerHTML = "";

    const items = quiz.items || quiz.questions || [];
    let questionCounter = 0;

    items.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = "question-card";

        // 1. Header / Section Instructions
        if (item.type === 'header') {
            div.style.background = "var(--bg-body, #f8fafc)";
            div.style.borderLeft = "5px solid var(--primary-blue, #1e5eff)";
            div.innerHTML = `
                <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 700; color: var(--text-dark);">${escapeHtml(item.text || item.title || 'Section')}</h3>
                ${item.description ? `<p style="margin:0; font-size:14px; line-height: 1.5; color:var(--text-gray);">${escapeHtml(item.description)}</p>` : ''}
            `;
        } 
        // 2. Reading Passage
        else if (item.type === 'passage') {
            div.style.borderLeft = "5px solid #10b981";
            let imgHtml = item.imageUrl ? `<img src="${item.imageUrl}" style="max-width:100%; border-radius:10px; margin:14px 0; border: 1px solid var(--border-color);">` : '';
            div.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                    <span style="background: rgba(16, 185, 129, 0.1); color: #10b981; font-size: 12px; font-weight: 800; padding: 4px 10px; border-radius: 6px; text-transform: uppercase;">Reading Passage</span>
                </div>
                <h4 style="margin: 0 0 10px 0; font-size: 16.5px; font-weight: 700; color:var(--text-dark);">${escapeHtml(item.title || 'Passage')}</h4>
                <div style="white-space: pre-line; background: var(--bg-body, #f8fafc); padding: 16px; border-radius: 10px; font-size: 14.5px; line-height: 1.65; border: 1px solid var(--border-color); color: var(--text-dark);">${escapeHtml(item.text || item.prompt)}</div>
                ${imgHtml}
            `;
        } 
        // 3. Multiple Choice Question
        else if (item.type === 'mcq' || (!item.type && item.question)) {
            questionCounter++;
            const prompt = item.prompt || item.question || '';
            let imgHtml = item.imageUrl ? `<img src="${item.imageUrl}" style="max-width:100%; border-radius:12px; margin:14px 0; border: 1px solid var(--border-color);">` : '';
            const pointsHtml = item.points ? `<span class="q-points-badge">${item.points} pt${item.points > 1 ? 's' : ''}</span>` : '';

            div.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span class="q-num-badge">No. ${questionCounter}</span>
                    ${pointsHtml}
                </div>
                <div class="quiz-question-text">${escapeHtml(prompt)}</div>
                ${imgHtml}
                <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
                    ${(item.options || []).map((opt, oIdx) => `
                        <label class="quiz-option-label">
                            <input type="radio" name="item_${idx}" value="${oIdx}">
                            <span>${escapeHtml(opt)}</span>
                        </label>
                    `).join('')}
                </div>
            `;
        } 
        // 4. Fill in the Blank
        else if (item.type === 'fill') {
            questionCounter++;
            const prompt = item.prompt || '';
            let imgHtml = item.imageUrl ? `<img src="${item.imageUrl}" style="max-width:100%; border-radius:12px; margin:14px 0; border: 1px solid var(--border-color);">` : '';
            const pointsHtml = item.points ? `<span class="q-points-badge">${item.points} pt${item.points > 1 ? 's' : ''}</span>` : '';

            div.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span class="q-num-badge">No. ${questionCounter}</span>
                    ${pointsHtml}
                </div>
                <div class="quiz-question-text">${escapeHtml(prompt)}</div>
                ${imgHtml}
                <textarea name="item_${idx}" class="auto-expand-input" rows="1" placeholder="Type your answer here..." oninput="autoResizeInput(this)"></textarea>
            `;
        } 
        // 5. Essay Question
        else if (item.type === 'essay') {
            questionCounter++;
            const prompt = item.prompt || '';
            let imgHtml = item.imageUrl ? `<img src="${item.imageUrl}" style="max-width:100%; border-radius:12px; margin:14px 0; border: 1px solid var(--border-color);">` : '';
            const pointsHtml = item.points ? `<span class="q-points-badge">${item.points} pt${item.points > 1 ? 's' : ''}</span>` : '';

            div.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span class="q-num-badge">No. ${questionCounter}</span>
                    ${pointsHtml}
                </div>
                <div class="quiz-question-text">${escapeHtml(prompt)}</div>
                ${imgHtml}
                <textarea name="item_${idx}" class="auto-expand-input" rows="3" placeholder="Write your full response here..." oninput="autoResizeInput(this)" style="min-height: 85px;"></textarea>
            `;
        } 
        // 6. Matching Question
        else if (item.type === 'matching') {
            questionCounter++;
            const prompt = item.prompt || '';
            let optionsHtml = (item.rights || []).map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
            div.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span class="q-num-badge">No. ${questionCounter}</span>
                </div>
                <div class="quiz-question-text">${escapeHtml(prompt)}</div>
                ${(item.lefts || []).map((left, lIdx) => `
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin:10px 0; background: var(--bg-body, #f8fafc); padding: 12px 16px; border-radius: 12px; border: 1px solid var(--border-color);">
                        <span style="font-size:14.5px; font-weight: 600; color: var(--text-dark);">${escapeHtml(left)}</span>
                        <select name="item_${idx}_${lIdx}" style="width:auto; margin:0; padding:8px 14px; font-size: 13.5px; font-weight: 600; border-radius: 8px;">
                            <option value="">-- Choose Match --</option>
                            ${optionsHtml}
                        </select>
                    </div>
                `).join('')}
            `;
        }

        form.appendChild(div);
    });

    document.getElementById('takeQuizSection').classList.remove('hidden');
}

// --- SUBMIT ASSESSMENT ---
document.getElementById('submitQuizBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!activeQuiz || !currentStudent) return;

    const form = document.getElementById('quizForm');
    const items = activeQuiz.items || activeQuiz.questions || [];
    
    let score = 0;
    let autoGradableCount = 0;
    const studentResponses = [];

    items.forEach((item, idx) => {
        if (item.type === 'header' || item.type === 'passage') return;

        // Multiple Choice
        if (item.type === 'mcq' || (!item.type && item.question)) {
            autoGradableCount++;
            const selected = form.querySelector(`input[name="item_${idx}"]:checked`);
            const val = selected ? parseInt(selected.value, 10) : null;
            const isCorrect = (val === item.correct);
            if (isCorrect) score++;
            const expectedOption = (item.options && item.correct !== undefined) ? item.options[item.correct] : "";
            studentResponses.push({ 
                prompt: item.prompt || item.question, 
                response: val !== null && item.options ? item.options[val] : "No answer",
                isCorrect: isCorrect,
                expected: expectedOption
            });
        } 
        // Fill in Blank
        else if (item.type === 'fill') {
            autoGradableCount++;
            const input = form.querySelector(`[name="item_${idx}"]`);
            const rawVal = input ? input.value.trim() : "";
            const val = rawVal.toLowerCase();
            const isCorrect = (item.answers && item.answers.map(a => a.toLowerCase().trim()).includes(val));
            if (isCorrect) score++;
            studentResponses.push({ 
                prompt: item.prompt, 
                response: rawVal || "No answer",
                isCorrect: isCorrect,
                expected: (item.answers || []).join(' / ')
            });
        } 
        // Essay
        else if (item.type === 'essay') {
            const textarea = form.querySelector(`textarea[name="item_${idx}"]`);
            studentResponses.push({ 
                prompt: item.prompt, 
                response: textarea ? textarea.value.trim() : "No answer",
                isEssay: true
            });
        } 
        // Matching
        else if (item.type === 'matching') {
            autoGradableCount++;
            let correctMatches = 0;
            (item.lefts || []).forEach((left, lIdx) => {
                const select = form.querySelector(`select[name="item_${idx}_${lIdx}"]`);
                if (select && item.rights && select.value === item.rights[lIdx]) {
                    correctMatches++;
                }
            });
            const isCorrect = (item.lefts && correctMatches === item.lefts.length);
            if (isCorrect) score++;
            studentResponses.push({ 
                prompt: item.prompt, 
                response: `${correctMatches}/${(item.lefts || []).length} pairs matched`,
                isCorrect: isCorrect,
                expected: (item.lefts || []).map((l, i) => `${l} → ${(item.rights || [])[i]}`).join(', ')
            });
        }
    });

    try {
        const submitBtn = document.getElementById('submitQuizBtn');
        submitBtn.innerText = "Submitting Assessment...";
        submitBtn.disabled = true;

        // Save complete submission payload to Firestore quiz_results
        await addDoc(collection(db, "quiz_results"), {
            studentCode: currentStudent.code,
            studentName: currentStudent.studentName || 'Student',
            quizId: activeQuiz.id || null,
            quizTitle: activeQuiz.title || 'Online Quiz',
            subject: activeQuiz.subject || "General",
            score: score,
            totalAutoGradable: autoGradableCount,
            responses: studentResponses,
            submittedAt: new Date().toISOString()
        });

        document.getElementById('takeQuizSection').classList.add('hidden');
        document.getElementById('scoreSummary').innerText = `You scored ${score} out of ${autoGradableCount} points!`;
        document.getElementById('resultSection').classList.remove('hidden');
        triggerCelebration();
        attachRippleEffect('button, .action-btn');

    } catch (err) {
        alert("Error submitting quiz: " + err.message);
        const submitBtn = document.getElementById('submitQuizBtn');
        submitBtn.innerText = "Submit Assessment";
        submitBtn.disabled = false;
    }
});