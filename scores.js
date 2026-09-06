import { collection, query, where, onSnapshot, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./utils.js";

let cachedExamScores = [];
let subjectComparisonChartInstance = null;
let subjectProgressChartInstance = null;
let activeProgressSubject = "ALL";
let unsubscribeScoresListener = null;

// --- THEME TOGGLE ---
const themeToggleBtn = document.getElementById('themeToggleBtn');
const mainThemeText = document.getElementById('mainThemeText');
const savedTheme = localStorage.getItem('appTheme') || 'light';

function applyScoresTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);
    document.body.classList.toggle('dark-mode', isDark);
    if (mainThemeText) mainThemeText.innerText = isDark ? 'Light Mode' : 'Dark Mode';
    document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
    document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
}

applyScoresTheme(savedTheme);

themeToggleBtn?.addEventListener('click', () => {
    const isDark = !document.body.classList.contains('dark-theme');
    const newTheme = isDark ? 'dark' : 'light';
    localStorage.setItem('appTheme', newTheme);
    localStorage.setItem('theme', newTheme);
    applyScoresTheme(newTheme);
    
    // Refresh charts with updated theme colors
    renderCharts();
});

// --- LOGOUT HANDLER ---
document.getElementById('studentLogoutBtn')?.addEventListener('click', () => {
    if (unsubscribeScoresListener) unsubscribeScoresListener();
    sessionStorage.removeItem('studentLoggedInSession');
    sessionStorage.removeItem('studentTimelineSession');
    localStorage.removeItem('loggedInStudentCode');
    window.location.href = "index.html";
});

let quizTypeCatalog = {};

// --- FETCH QUIZ TYPES FROM DATABASE CATALOG ---
async function fetchQuizTypeCatalog() {
    try {
        const [qSnap, sysSnap] = await Promise.all([
            getDocs(collection(db, "quizzes")),
            getDocs(collection(db, "system_quizzes"))
        ]);
        qSnap.forEach(d => {
            const data = d.data();
            const title = (data.title || data.quizName || data.name || d.id).trim().toLowerCase();
            if (data.type && title) quizTypeCatalog[title] = data.type;
        });
        sysSnap.forEach(d => {
            const data = d.data();
            const title = (data.name || data.title || data.quizName || d.id).trim().toLowerCase();
            if (data.type && title) quizTypeCatalog[title] = data.type;
        });
    } catch (e) {
        console.warn("Could not fetch quiz catalog:", e);
    }
}

// --- INITIALIZE REAL-TIME LISTENER ---
window.addEventListener('DOMContentLoaded', async () => {
    const savedLoggedIn = sessionStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession');
    let studentCode = '';

    if (savedLoggedIn) {
        try {
            const session = JSON.parse(savedLoggedIn);
            studentCode = session.code || session.studentCode || session.id || '';
        } catch (e) {
            console.error(e);
        }
    }

    if (!studentCode) {
        studentCode = localStorage.getItem('loggedInStudentCode') || '';
    }

    if (!studentCode) {
        window.location.href = "index.html";
        return;
    }

    const cleanCode = studentCode.trim().toUpperCase();

    // Fetch quiz database types first so badges accurately match the quiz database
    await fetchQuizTypeCatalog();

    initRealTimeScoresListener(cleanCode);
});

// --- SUBJECT RESOLVER HELPER ---
function resolveSubject(rawSubject, examName) {
    const s = (rawSubject || '').toString().trim();
    if (s && s.toLowerCase() !== 'general' && s.toLowerCase() !== 'general assessment' && s.toLowerCase() !== 'n/a' && s.toLowerCase() !== 'unknown') {
        return s;
    }
    const name = (examName || '').toLowerCase();
    if (name.includes('ict') || name.includes('brand') || name.includes('computer') || name.includes('tech') || name.includes('python')) {
        return 'ICT';
    }
    return 'English';
}

// --- REAL-TIME FIRESTORE LISTENER (CASE-INSENSITIVE & DEDUPLICATED BY EXAM TITLE) ---
function initRealTimeScoresListener(studentCode) {
    const rawCode = (studentCode || '').toString().trim();
    const upperCode = rawCode.toUpperCase();
    const lowerCode = rawCode.toLowerCase();

    const scoreQuery = query(collection(db, "exam_scores"), where("studentCode", "==", upperCode));

    unsubscribeScoresListener = onSnapshot(scoreQuery, async (snapshot) => {
        const scoresMap = new Map();
        const optionsSet = new Set();
        const subjectsSet = new Set();

        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const examTitle = (data.examName || data.quizName || docSnap.id).trim();
            const subject = resolveSubject(data.subject, examTitle);
            const normTitle = examTitle.toLowerCase();

            scoresMap.set(normTitle, {
                id: docSnap.id,
                ...data,
                examName: examTitle,
                quizName: examTitle,
                subject: subject,
                score: data.score
            });
            if (examTitle) optionsSet.add(examTitle);
            if (subject) subjectsSet.add(subject);
        });

        // 1. Check lowercase studentCode in exam_scores if different
        if (upperCode !== lowerCode) {
            try {
                const lowerSnap = await getDocs(query(collection(db, "exam_scores"), where("studentCode", "==", lowerCode)));
                lowerSnap.forEach(docSnap => {
                    const data = docSnap.data();
                    const examTitle = (data.examName || data.quizName || docSnap.id).trim();
                    const normTitle = examTitle.toLowerCase();

                    if (!scoresMap.has(normTitle)) {
                        const subject = resolveSubject(data.subject, examTitle);
                        scoresMap.set(normTitle, {
                            id: docSnap.id,
                            ...data,
                            examName: examTitle,
                            quizName: examTitle,
                            subject: subject,
                            score: data.score
                        });
                        if (examTitle) optionsSet.add(examTitle);
                        if (subject) subjectsSet.add(subject);
                    }
                });
            } catch (e) { }
        }

        // 2. Check legacy "scores" collection ONLY for exams not already in exam_scores
        try {
            const legacySnap = await getDocs(query(collection(db, "scores"), where("studentCode", "==", upperCode)));
            legacySnap.forEach(docSnap => {
                const data = docSnap.data();
                const examTitle = (data.quizTitle || data.examName || docSnap.id).trim();
                const normTitle = examTitle.toLowerCase();

                if (!scoresMap.has(normTitle) && data.score !== undefined && data.score !== null && !isNaN(parseFloat(data.score))) {
                    const subject = resolveSubject(data.subject, examTitle);
                    scoresMap.set(normTitle, {
                        id: docSnap.id,
                        examName: examTitle,
                        quizName: examTitle,
                        subject: subject,
                        score: data.score,
                        studentCode: upperCode,
                        studentName: data.studentName,
                        studentClass: data.studentClass,
                        type: data.type || resolveScoreType(data)
                    });
                    if (examTitle) optionsSet.add(examTitle);
                    if (subject) subjectsSet.add(subject);
                }
            });
        } catch (e) { }

        cachedExamScores = Array.from(scoresMap.values());

        // Sort chronologically or by updated date
        cachedExamScores.sort((a, b) => {
            const tA = a.updatedAt ? (a.updatedAt.seconds ? a.updatedAt.seconds : new Date(a.updatedAt).getTime()) : 0;
            const tB = b.updatedAt ? (b.updatedAt.seconds ? b.updatedAt.seconds : new Date(b.updatedAt).getTime()) : 0;
            return tB - tA;
        });

        // Populate Dropdowns
        updateDropdowns(optionsSet, subjectsSet);

        // Update Top 4 Metric Summaries & Subject Highlights
        updateSummaryMetrics();

        // Render Performance & Comparison Diagrams
        renderCharts();

        // Spotlight most recent or keep selected
        if (cachedExamScores.length > 0) {
            spotlightScore(cachedExamScores[0]);
        }

        // Render All Cards Grid
        renderScoreCards();

    }, (error) => {
        console.error("Real-time exam scores error:", error);
    });
}

// --- QUIZ TYPE WEIGHT CONFIGURATION ---
export const QUIZ_TYPE_WEIGHTS = {
    "Exercise": 0.075,      // 7.5%
    "Homework": 0.075,      // 7.5%
    "Quiz": 0.15,           // 15%
    "Review": 0.15,         // 15%
    "Practical Test": 0.15, // 15%
    "Final Exam": 0.25      // 25%
};

export function normalizeQuizType(typeStr) {
    if (!typeStr) return 'Exercise';
    const t = typeStr.toString().trim();
    const lower = t.toLowerCase();
    if (lower === 'skill' || lower === 'project' || lower.includes('practical')) return 'Practical Test';
    if (lower === 'final test' || lower === 'final' || lower.includes('final exam') || lower === 'exam' || lower === 'midterm') return 'Final Exam';
    if (lower.includes('review')) return 'Review';
    if (lower.includes('homework') || lower.includes('hw')) return 'Homework';
    if (lower.includes('quiz') || lower.includes('test')) return 'Quiz';
    if (lower.includes('exercise')) return 'Exercise';
    return 'Exercise';
}

let activeAverageSubject = 'ALL';
let availableSubjectsList = [];
let activeScoreFilterSubject = 'ALL';
let activeScoreFilterExam = 'ALL';

// --- CALCULATE WEIGHTED AVERAGE ---
export function calculateWeightedScore(scoresList) {
    if (!scoresList || scoresList.length === 0) return null;

    const categoryScores = {};
    scoresList.forEach(item => {
        const val = parseFloat(item.score);
        if (!isNaN(val)) {
            const cat = resolveScoreType(item);
            if (!categoryScores[cat]) categoryScores[cat] = [];
            categoryScores[cat].push(val);
        }
    });

    let totalWeight = 0;
    let weightedSum = 0;

    for (const [cat, vals] of Object.entries(categoryScores)) {
        const weight = QUIZ_TYPE_WEIGHTS[cat] !== undefined ? QUIZ_TYPE_WEIGHTS[cat] : 0.075;
        const catAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
        weightedSum += catAvg * weight;
        totalWeight += weight;
    }

    if (totalWeight === 0) return null;
    return (weightedSum / totalWeight);
}

// --- POPULATE DROPDOWNS ---
function updateDropdowns(optionsSet, subjectsSet) {
    availableSubjectsList = Array.from(subjectsSet).sort();

    // 1. Subject Filter in All Scores
    const subjectFilter = document.getElementById('scoreSubjectFilter');
    if (subjectFilter) {
        subjectFilter.innerHTML = '<option value="ALL">All Subjects</option>';
        availableSubjectsList.forEach(subj => {
            subjectFilter.innerHTML += `<option value="${subj}">${subj}</option>`;
        });
        if (availableSubjectsList.includes(activeScoreFilterSubject) || activeScoreFilterSubject === "ALL") {
            subjectFilter.value = activeScoreFilterSubject;
        }
    }

    // 2. Exam Filter in All Scores
    updateExamFilterDropdown();

    // 3. Progress Subject Filter
    const progressFilter = document.getElementById('progressSubjectFilter');
    const currentProgressVal = progressFilter?.value || activeProgressSubject;

    if (progressFilter) {
        progressFilter.innerHTML = '<option value="ALL">All Subjects</option>';
        availableSubjectsList.forEach(subj => {
            progressFilter.innerHTML += `<option value="${subj}">${subj}</option>`;
        });
        if (availableSubjectsList.includes(currentProgressVal) || currentProgressVal === "ALL") {
            progressFilter.value = currentProgressVal;
            activeProgressSubject = currentProgressVal;
        }
    }
}

function updateExamFilterDropdown() {
    const examFilter = document.getElementById('examScoreDropdown');
    if (!examFilter) return;

    const filteredScores = activeScoreFilterSubject === "ALL"
        ? cachedExamScores
        : cachedExamScores.filter(s => resolveSubject(s.subject, s.examName) === activeScoreFilterSubject);

    const distinctExams = Array.from(new Set(filteredScores.map(s => s.examName || s.quizName).filter(Boolean))).sort();

    examFilter.innerHTML = '<option value="ALL">All Assignments</option>';
    distinctExams.forEach(item => {
        examFilter.innerHTML += `<option value="${item}">${item}</option>`;
    });

    if (distinctExams.includes(activeScoreFilterExam) || activeScoreFilterExam === "ALL") {
        examFilter.value = activeScoreFilterExam;
    } else {
        activeScoreFilterExam = "ALL";
        examFilter.value = "ALL";
    }
}

// --- UPDATE SUMMARY STATS ---
function updateSummaryMetrics() {
    const totalCount = cachedExamScores.length;
    document.getElementById('statTotalTests').innerText = totalCount;

    const subjectMap = {};
    cachedExamScores.forEach(item => {
        const subject = resolveSubject(item.subject, item.examName);
        if (!subjectMap[subject]) {
            subjectMap[subject] = [];
        }
        subjectMap[subject].push(item);
    });

    // Render active Average Score (Weighted)
    renderAverageScoreCard(subjectMap);

    // Determine Strongest & Focus Subject based on weighted average
    let bestSubjectName = '-';
    let bestSubjectAvg = -1;
    let worstSubjectName = '-';
    let worstSubjectAvg = 999;

    availableSubjectsList.forEach(subj => {
        const sWeighted = calculateWeightedScore(subjectMap[subj]);
        if (sWeighted !== null) {
            if (sWeighted > bestSubjectAvg) {
                bestSubjectAvg = sWeighted;
                bestSubjectName = subj;
            }
            if (sWeighted < worstSubjectAvg) {
                worstSubjectAvg = sWeighted;
                worstSubjectName = subj;
            }
        }
    });

    if (bestSubjectAvg >= 0) {
        document.getElementById('statBestSubject').innerText = `${bestSubjectName} (${bestSubjectAvg.toFixed(1)})`;
        document.getElementById('statFocusSubject').innerText = `${worstSubjectName} (${worstSubjectAvg.toFixed(1)})`;
    } else {
        document.getElementById('statBestSubject').innerText = '-';
        document.getElementById('statFocusSubject').innerText = '-';
    }
}

function renderAverageScoreCard(subjectMap) {
    const labelEl = document.getElementById('statAverageLabel');
    const scoreEl = document.getElementById('statAverageScore');
    if (!labelEl || !scoreEl) return;

    if (activeAverageSubject === 'ALL') {
        const overallWeighted = calculateWeightedScore(cachedExamScores);
        labelEl.innerText = "Average (All Subjects)";
        scoreEl.innerText = overallWeighted !== null ? overallWeighted.toFixed(1) : "-";
    } else {
        const list = (subjectMap && subjectMap[activeAverageSubject]) || cachedExamScores.filter(s => resolveSubject(s.subject, s.examName) === activeAverageSubject);
        const subjWeighted = calculateWeightedScore(list);
        labelEl.innerText = `Average (${activeAverageSubject})`;
        scoreEl.innerText = subjWeighted !== null ? subjWeighted.toFixed(1) : "-";
    }
}

// Click event to cycle through subjects on Average Card
document.getElementById('statAverageCard')?.addEventListener('click', () => {
    if (availableSubjectsList.length === 0) return;
    const cycle = ['ALL', ...availableSubjectsList];
    const currIdx = cycle.indexOf(activeAverageSubject);
    const nextIdx = (currIdx + 1) % cycle.length;
    activeAverageSubject = cycle[nextIdx];

    const card = document.getElementById('statAverageCard');
    if (card) {
        card.style.transform = 'scale(0.96)';
        setTimeout(() => card.style.transform = 'scale(1)', 120);
    }

    renderAverageScoreCard();
});

// --- CHART RENDERING ENGINE (CHART.JS) ---
function renderCharts() {
    if (typeof Chart === 'undefined') return;

    const isDark = document.body.classList.contains('dark-theme') || document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#cbd5e1' : '#475569';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';

    renderSubjectComparisonChart(isDark, textColor, gridColor);
    renderSubjectProgressChart(isDark, textColor, gridColor);
}

// Diagram 1: Subject Average & Mastery Comparison
function renderSubjectComparisonChart(isDark, textColor, gridColor) {
    const canvas = document.getElementById('subjectComparisonChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (subjectComparisonChartInstance) {
        subjectComparisonChartInstance.destroy();
    }

    if (cachedExamScores.length === 0) {
        return;
    }

    // Aggregate by Subject
    const subjectMap = {};
    cachedExamScores.forEach(item => {
        const subject = resolveSubject(item.subject, item.examName);
        const score = parseFloat(item.score) || 0;
        if (!subjectMap[subject]) {
            subjectMap[subject] = { sum: 0, count: 0 };
        }
        subjectMap[subject].sum += score;
        subjectMap[subject].count += 1;
    });

    const subjects = Object.keys(subjectMap).sort();
    const averages = subjects.map(s => (subjectMap[s].sum / subjectMap[s].count).toFixed(1));

    // Dynamic Color Coding based on score tier
    const bgColors = averages.map(val => {
        const num = parseFloat(val);
        if (num >= 85) return 'rgba(16, 185, 129, 0.85)'; // Emerald Green
        if (num >= 70) return 'rgba(245, 158, 11, 0.85)';  // Amber Gold
        return 'rgba(239, 68, 68, 0.85)';                 // Coral Red
    });

    const borderColors = averages.map(val => {
        const num = parseFloat(val);
        if (num >= 85) return '#10b981';
        if (num >= 70) return '#f59e0b';
        return '#ef4444';
    });

    subjectComparisonChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: subjects,
            datasets: [{
                label: 'Average Score',
                data: averages,
                backgroundColor: bgColors,
                borderColor: borderColors,
                borderWidth: 1.5,
                borderRadius: 8,
                borderSkipped: false,
                barThickness: subjects.length > 4 ? 22 : 32
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? '#1e293b' : '#0f172a',
                    titleColor: '#ffffff',
                    bodyColor: '#e2e8f0',
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: {
                        label: (ctx) => {
                            const subj = ctx.label;
                            const count = subjectMap[subj]?.count || 0;
                            return ` Avg Score: ${ctx.parsed.y} pts (${count} test${count > 1 ? 's' : ''})`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: 0,
                    max: 100,
                    ticks: {
                        color: textColor,
                        font: { family: 'Inter', size: 11, weight: '600' },
                        stepSize: 20
                    },
                    grid: { color: gridColor }
                },
                x: {
                    ticks: {
                        color: textColor,
                        font: { family: 'Inter', size: 11.5, weight: '700' }
                    },
                    grid: { display: false }
                }
            }
        }
    });
}

// Diagram 2: Score Progress Timeline Chart
function renderSubjectProgressChart(isDark, textColor, gridColor) {
    const canvas = document.getElementById('subjectProgressChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (subjectProgressChartInstance) {
        subjectProgressChartInstance.destroy();
    }

    if (cachedExamScores.length === 0) {
        return;
    }

    // Filter tests by selected subject
    let filteredScores = [...cachedExamScores];
    if (activeProgressSubject && activeProgressSubject !== "ALL") {
        filteredScores = filteredScores.filter(s => s.subject === activeProgressSubject);
    }

    // Reverse for chronological order (oldest to newest)
    const chronologicalScores = [...filteredScores].reverse();

    const labels = chronologicalScores.map((s, idx) => {
        const name = s.examName || s.quizName || `Test ${idx + 1}`;
        return name.length > 14 ? name.substring(0, 12) + '…' : name;
    });

    const dataPoints = chronologicalScores.map(s => parseFloat(s.score) || 0);

    // Calculate Trend & Summary
    if (dataPoints.length > 0) {
        const latest = dataPoints[dataPoints.length - 1];
        const highest = Math.max(...dataPoints);
        document.getElementById('progressLatestScore').innerText = `${latest} pts`;
        document.getElementById('progressHighestScore').innerText = `${highest} pts`;

        const trendEl = document.getElementById('progressTrendStatus');
        if (dataPoints.length > 1) {
            const first = dataPoints[0];
            const diff = latest - first;
            if (diff > 0) {
                trendEl.innerHTML = `<span style="color: #10b981;">+${diff.toFixed(0)} pts ↗</span>`;
            } else if (diff < 0) {
                trendEl.innerHTML = `<span style="color: #ef4444;">${diff.toFixed(0)} pts ↘</span>`;
            } else {
                trendEl.innerHTML = `<span style="color: #3b82f6;">Steady ➔</span>`;
            }
        } else {
            trendEl.innerText = "Baseline";
        }
    } else {
        document.getElementById('progressLatestScore').innerText = '-';
        document.getElementById('progressHighestScore').innerText = '-';
        document.getElementById('progressTrendStatus').innerText = '-';
    }

    // Create Gradient Fill
    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(168, 85, 247, 0.4)');
    gradient.addColorStop(1, 'rgba(168, 85, 247, 0.0)');

    subjectProgressChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Score',
                data: dataPoints,
                borderColor: '#a855f7',
                borderWidth: 3,
                backgroundColor: gradient,
                fill: true,
                tension: 0.35,
                pointBackgroundColor: '#a855f7',
                pointBorderColor: isDark ? '#1e293b' : '#ffffff',
                pointBorderWidth: 2,
                pointRadius: 5,
                pointHoverRadius: 7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? '#1e293b' : '#0f172a',
                    titleColor: '#ffffff',
                    bodyColor: '#e2e8f0',
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: {
                        title: (items) => {
                            const idx = items[0]?.dataIndex;
                            return chronologicalScores[idx]?.examName || chronologicalScores[idx]?.quizName || 'Test';
                        },
                        label: (ctx) => {
                            const idx = ctx.dataIndex;
                            const subj = chronologicalScores[idx]?.subject || '';
                            return ` Score: ${ctx.parsed.y} pts (${subj})`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: 0,
                    max: 100,
                    ticks: {
                        color: textColor,
                        font: { family: 'Inter', size: 11, weight: '600' },
                        stepSize: 20
                    },
                    grid: { color: gridColor }
                },
                x: {
                    ticks: {
                        color: textColor,
                        font: { family: 'Inter', size: 11, weight: '600' }
                    },
                    grid: { display: false }
                }
            }
        }
    });
}

// Progress Subject Dropdown Event Listener
document.getElementById('progressSubjectFilter')?.addEventListener('change', (e) => {
    activeProgressSubject = e.target.value;
    const isDark = document.body.classList.contains('dark-theme') || document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#cbd5e1' : '#475569';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';
    renderSubjectProgressChart(isDark, textColor, gridColor);
});

// --- QUIZ TYPE RESOLVER & BADGE HELPER ---
function resolveScoreType(data) {
    const name = (data.examName || data.quizName || '').trim();
    const lowerName = name.toLowerCase();

    // 1. Top Priority: Direct catalog lookup from quizzes and system_quizzes
    if (quizTypeCatalog[lowerName]) {
        return normalizeQuizType(quizTypeCatalog[lowerName]);
    }
    // 2. Partial match in catalog
    for (const [catTitle, catType] of Object.entries(quizTypeCatalog)) {
        if (lowerName === catTitle || lowerName.includes(catTitle) || catTitle.includes(lowerName)) {
            return normalizeQuizType(catType);
        }
    }

    // 3. Stored type on document
    if (data.type) return normalizeQuizType(data.type);

    // 4. Heuristic inference
    if (lowerName.includes('review')) return 'Review';
    if (lowerName.includes('final') || lowerName.includes('exam') || lowerName.includes('midterm')) return 'Final Exam';
    if (lowerName.includes('practical') || lowerName.includes('skill') || lowerName.includes('project')) return 'Practical Test';
    if (lowerName.includes('homework') || lowerName.includes('hw')) return 'Homework';
    if (lowerName.includes('quiz') || lowerName.includes('test')) return 'Quiz';
    return 'Exercise'; // Default to Exercise
}

function getTypeBadgeHtml(type) {
    const t = normalizeQuizType(type);
    let bg = 'rgba(22, 163, 74, 0.08)';
    let color = '#16a34a';
    let border = 'rgba(22, 163, 74, 0.25)';

    if (t === 'Final Exam') {
        bg = 'rgba(220, 38, 38, 0.08)';
        color = '#dc2626';
        border = 'rgba(220, 38, 38, 0.25)';
    } else if (t === 'Review') {
        bg = 'rgba(147, 51, 234, 0.08)';
        color = '#9333ea';
        border = 'rgba(147, 51, 234, 0.25)';
    } else if (t === 'Homework') {
        bg = 'rgba(234, 88, 12, 0.08)';
        color = '#ea580c';
        border = 'rgba(234, 88, 12, 0.25)';
    } else if (t === 'Quiz') {
        bg = 'rgba(37, 99, 235, 0.08)';
        color = '#2563eb';
        border = 'rgba(37, 99, 235, 0.25)';
    } else if (t === 'Practical Test') {
        bg = 'rgba(13, 148, 136, 0.08)';
        color = '#0d9488';
        border = 'rgba(13, 148, 136, 0.25)';
    }

    return `<span style="background: ${bg}; color: ${color}; border: 1px solid ${border}; font-size: 11.5px; font-weight: 700; padding: 2px 8px; border-radius: 6px;">${t}</span>`;
}

// --- SPOTLIGHT HANDLER ---
function spotlightScore(data) {
    const title = data.examName || data.quizName || 'Assessment Result';
    const subject = resolveSubject(data.subject, title);
    const scoreVal = data.score !== undefined ? data.score : '--';
    const type = resolveScoreType(data);

    document.getElementById('spotlightTitle').innerText = title;
    document.getElementById('spotlightSubject').innerHTML = `<span style="display: inline-flex; align-items: center; gap: 8px;"><span>Subject: <strong>${escapeHtml(subject)}</strong></span> <span style="background: rgba(255,255,255,0.18); padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; border: 1px solid rgba(255,255,255,0.3);">${type}</span></span>`;
    document.getElementById('spotlightScoreValue').innerText = scoreVal;
}

// --- RENDER SCORE CARDS GRID ---
function renderScoreCards() {
    const gridContainer = document.getElementById('scoreCardsGrid');
    if (!gridContainer) return;
    gridContainer.innerHTML = "";

    let filtered = cachedExamScores;

    // Filter by Subject
    if (activeScoreFilterSubject !== "ALL") {
        filtered = filtered.filter(s => resolveSubject(s.subject, s.examName) === activeScoreFilterSubject);
    }

    // Filter by Exam / Assignment
    if (activeScoreFilterExam !== "ALL") {
        filtered = filtered.filter(s => (s.examName === activeScoreFilterExam || s.quizName === activeScoreFilterExam));
    }

    if (filtered.length === 0) {
        gridContainer.innerHTML = `<div style="grid-column: 1/-1; text-align:center; color:var(--text-gray); padding: 40px; background: var(--card-bg); border-radius: 16px; border: 1px dashed var(--border-color);">No score record found for the selected filter.</div>`;
        return;
    }

    filtered.forEach((data) => {
        const title = data.examName || data.quizName || 'Assessment';
        const subject = resolveSubject(data.subject, title);
        const score = data.score;
        const numScore = parseFloat(score) || 0;
        const type = resolveScoreType(data);
        const typeBadge = getTypeBadgeHtml(type);

        let scoreBg = '#ecfdf5';
        let scoreColor = '#10b981';
        let scoreBorder = '#a7f3d0';

        if (numScore < 70 && numScore > 0) {
            scoreBg = '#fef2f2';
            scoreColor = '#ef4444';
            scoreBorder = '#fca5a5';
        } else if (numScore < 85 && numScore >= 70) {
            scoreBg = '#fffbe5';
            scoreColor = '#d97706';
            scoreBorder = '#fde68a';
        }

        const card = document.createElement('div');
        card.className = 'interactive-score-card';
        card.style.cssText = `
            background: var(--card-bg, #ffffff);
            border: 1px solid var(--border-color, #e2e8f0);
            border-radius: 20px;
            padding: 24px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.03);
            cursor: pointer;
            transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
        `;

        card.innerHTML = `
            <div>
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; gap: 8px;">
                    <span style="font-size: 11.5px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-gray); font-weight: 700;">${subject}</span>
                    ${typeBadge}
                </div>
                <h4 style="margin: 0 0 16px 0; font-size: 17px; font-weight: 800; color: var(--text-dark); line-height: 1.3;">${title}</h4>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 14px; border-top: 1px solid var(--border-color, #f1f5f9);">
                <span style="font-size: 12.5px; font-weight: 600; color: var(--text-gray);">Score:</span>
                <span style="background: ${scoreBg}; color: ${scoreColor}; border: 1px solid ${scoreBorder}; font-size: 26px; font-weight: 900; padding: 4px 16px; border-radius: 12px; line-height: 1;">
                    ${score}
                </span>
            </div>
        `;

        card.addEventListener('mouseenter', () => {
            card.style.transform = 'translateY(-4px)';
            card.style.boxShadow = '0 12px 24px rgba(30, 94, 255, 0.12)';
            card.style.borderColor = '#1e5eff';
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = 'translateY(0)';
            card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.03)';
            card.style.borderColor = 'var(--border-color, #e2e8f0)';
        });

        card.addEventListener('click', () => {
            spotlightScore(data);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        gridContainer.appendChild(card);
    });
}

// Subject Filter Dropdown Event Listener
document.getElementById('scoreSubjectFilter')?.addEventListener('change', (e) => {
    activeScoreFilterSubject = e.target.value;
    updateExamFilterDropdown();
    renderScoreCards();
});

// Exam Filter Dropdown Event Listener
document.getElementById('examScoreDropdown')?.addEventListener('change', (e) => {
    activeScoreFilterExam = e.target.value;
    renderScoreCards();
});
