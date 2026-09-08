// ==========================================================================
// BOARD.JS - Interactive Whiteboard & Digital Brainstorming Studio
// ==========================================================================

import { 
    collection, addDoc, getDocs, doc, deleteDoc, updateDoc, 
    query, where, getDoc, setDoc, onSnapshot, orderBy 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./firebase.js";
import { escapeHtml, formatDate } from "./utils.js";

// --- GLOBAL STATE ---
let currentUser = null; // { type: 'student'|'staff', code, name, studentClass, uid, role }
let currentBoard = null;
let currentBoardId = null;
let activeTab = 'my-boards'; // 'my-boards' | 'teacher-boards'
let myBoardsList = [];
let teacherBoardsList = [];

// Whiteboard Engine State
let elements = [];
let selectedElementIds = new Set();
let undoStack = [];
let redoStack = [];
let isRightClickPanning = false;
let previousToolBeforeRightClick = null;
let studentSharedBoardsList = [];
let availableTeachersList = [];
let schoolClassesList = ["Grade 7A", "Grade 7B", "Grade 8A", "Grade 8B", "Grade 9A", "Grade 9B", "Grade 9C", "Grade 10A", "Grade 10B", "Grade 11A", "Grade 12"];
let activeTool = 'select'; // 'select'|'pan'|'sticky'|'shape'|'text'|'pen'|'highlighter'|'line'|'arrow'|'eraser'
let activeShapeType = 'rectangle';
let activeStickyColor = '#fef08a'; // Yellow
let activePenColor = '#1e293b';
let activePenSize = 4;
let activeHighlighterColor = '#facc15';
let activeHighlighterSize = 8;
let activeLineColor = '#1e5eff';
let activeLineWidth = 2.5;
let camera = { x: 0, y: 0, zoom: 1 };
let isDragging = false;
let isPanning = false;
let isDrawing = false;
let isErasing = false;
let isConnectingLine = false;
let currentLineStart = null;
let currentLineEnd = null;
let startBinding = null;
let endBinding = null;
let hoveredMagnet = null;
let dragStart = { x: 0, y: 0 };
let currentDrawPoints = [];
let isResizing = false;
let activeResizeHandle = null; // 'nw', 'ne', 'se', 'sw', 'start', 'end'
let activeResizeElement = null;
let resizeStart = null;
let initialElementStates = new Map();
let autoSaveTimer = null;
let hasUnsavedChanges = false;
let gridStyle = 'dots'; // 'dots' | 'lines' | 'blank'
let editingElementId = null; // ID of element currently undergoing in-place inline text editing

// Sticky color presets
const STICKY_COLORS = [
    { name: 'Yellow', bg: '#fef08a', text: '#713f12', border: '#fde047' },
    { name: 'Pink', bg: '#fbcfe8', text: '#831843', border: '#f472b6' },
    { name: 'Green', bg: '#bbf7d0', text: '#14532d', border: '#86efac' },
    { name: 'Blue', bg: '#bae6fd', text: '#0c4a6e', border: '#7dd3fc' },
    { name: 'Purple', bg: '#e9d5ff', text: '#581c87', border: '#d8b4fe' },
    { name: 'Orange', bg: '#fed7aa', text: '#7c2d12', border: '#fdba74' },
    { name: 'Charcoal', bg: '#334155', text: '#f8fafc', border: '#475569' }
];

// --- 1. AUTHENTICATION & INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    await initAuthAndUser();
    setupHubEventListeners();
    setupCanvasEventListeners();
    setupKeyboardShortcuts();
});

async function initAuthAndUser() {
    // 1. Check Firebase Auth first for Staff (Teacher / Admin)
    const firebaseUser = await new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            unsubscribe();
            resolve(user);
        });
        setTimeout(() => {
            resolve(auth.currentUser || null);
        }, 800);
    });

    if (firebaseUser) {
        try {
            const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
            let userData = userDoc.exists() ? userDoc.data() : {};
            let role = userData.role;
            if (!role) {
                role = (firebaseUser.email && firebaseUser.email.toLowerCase().includes('admin')) ? 'admin' : 'teacher';
            }

            const rawEmail = firebaseUser.email || userData.email || '';
            const formattedName = rawEmail ? rawEmail.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Teacher';
            const displayName = (userData && userData.name) || firebaseUser.displayName || (role === 'admin' ? 'Administrator' : formattedName);

            currentUser = {
                type: 'staff',
                uid: firebaseUser.uid,
                email: rawEmail,
                name: displayName,
                role: role, // 'admin' | 'teacher'
                subject: userData.subject || 'All',
                studentClass: 'All',
                photoUrl: userData.photoUrl || firebaseUser.photoURL || ''
            };

            updateNavUserUI();
            await loadBoards();
            await checkDirectBoardParam();
            return;
        } catch (e) {
            console.warn("Staff profile fetch err:", e);
        }
    }

    // 2. Check for Student Session if not staff
    let studentCode = localStorage.getItem('loggedInStudentCode') || localStorage.getItem('studentCode') || '';
    let studentData = null;

    const rawSession = sessionStorage.getItem('studentLoggedInSession') 
        || localStorage.getItem('studentLoggedInSession') 
        || sessionStorage.getItem('studentTimelineSession') 
        || localStorage.getItem('studentTimelineSession');
    if (rawSession) {
        try {
            const parsed = JSON.parse(rawSession);
            studentCode = parsed.code || parsed.studentCode || parsed.id || studentCode;
            studentData = parsed;
        } catch (e) {
            console.warn("Session parse error:", e);
        }
    }

    if (studentCode) {
        studentCode = studentCode.trim().toUpperCase();
        try {
            if (!studentData || !studentData.name || !studentData.studentClass) {
                const studentSnap = await getDoc(doc(db, "students", studentCode));
                if (studentSnap.exists()) {
                    const s = studentSnap.data();
                    studentData = {
                        name: s.studentName || s.name || 'Student',
                        studentClass: s.studentClass || s.class || 'Unassigned',
                        photoUrl: s.photoUrl || s.photo || ''
                    };
                }
            }

            if (studentData) {
                currentUser = {
                    type: 'student',
                    code: studentCode,
                    name: (studentData && (studentData.name || studentData.studentName)) || 'Student',
                    studentClass: (studentData && (studentData.studentClass || studentData.class)) || 'Unassigned',
                    photoUrl: (studentData && studentData.photoUrl) || ''
                };
                // For student, navigate directly to their board view
                activeTab = 'my-boards';
                updateNavUserUI();
                await loadBoards();
                await checkDirectBoardParam();
                return;
            }
        } catch (err) {
            console.warn("Student profile load err:", err);
        }
    }

    // 3. Unauthorized access check: neither staff nor student -> immediately redirect to index.html
    console.warn("Unauthorized: No authenticated session found. Redirecting to login...");
    window.location.replace('index.html');
}

async function checkDirectBoardParam() {
    const urlParams = new URLSearchParams(window.location.search);
    const directBoardId = urlParams.get('id');
    if (directBoardId) {
        await window.openBoardEditor(directBoardId);
    }
}

function updateNavUserUI() {
    if (!currentUser) return;
    const isStaff = currentUser.type === 'staff';
    const nameEl = document.getElementById('hubUserName');
    if (nameEl) nameEl.innerText = currentUser.name;

    // For teacher and admin: hide other tabs (dashboard, online quiz, timeline, profile, score)
    document.querySelectorAll('.student-only-nav').forEach(el => {
        if (isStaff) {
            el.style.setProperty('display', 'none', 'important');
        } else {
            el.style.removeProperty('display');
        }
    });

    // Brand subtitle customization
    const brandSubtitle = document.querySelector('.brand p');
    if (brandSubtitle) {
        if (isStaff) {
            brandSubtitle.innerText = currentUser.role === 'admin' ? 'Admin Whiteboard Studio' : 'Teacher Whiteboard Studio';
        } else {
            brandSubtitle.innerText = 'Student Portal System';
        }
    }

    // Show/hide teacher-specific controls (e.g. sharing selector, student shared tab)
    const studentSharedTab = document.getElementById('tabStudentSharedBoards');
    if (studentSharedTab) {
        studentSharedTab.classList.toggle('hidden', !isStaff);
    }

    document.querySelectorAll('.teacher-only-control').forEach(el => {
        el.classList.toggle('hidden', !isStaff);
    });

    // In mobile kebab menu, update "For Teacher" link label for admin
    const forTeacherMobileLink = document.querySelector('#mobileTopbarDropdown a[href="admin.html"] span');
    if (forTeacherMobileLink && currentUser.role === 'admin') {
        forTeacherMobileLink.innerText = 'Admin Portal';
    }
}

// --- 2. BOARD HUB MANAGEMENT ---
async function loadBoards() {
    if (!currentUser) return;
    const myGrid = document.getElementById('myBoardsGrid');
    const teacherGrid = document.getElementById('teacherBoardsGrid');
    const studentSharedGrid = document.getElementById('studentSharedBoardsGrid');
    const myCount = document.getElementById('myBoardsCount');
    const teacherCount = document.getElementById('teacherBoardsCount');
    const studentSharedCount = document.getElementById('studentSharedBoardsCount');

    try {
        // 1. Fetch My Personal Boards from Firestore
        let myQuery;
        if (currentUser.type === 'staff') {
            myQuery = query(collection(db, "boards"), where("authorUid", "==", currentUser.uid));
        } else {
            myQuery = query(collection(db, "boards"), where("authorCode", "==", currentUser.code));
        }

        const mySnap = await getDocs(myQuery);
        myBoardsList = [];
        mySnap.forEach(docSnap => myBoardsList.push({ id: docSnap.id, ...docSnap.data() }));

        // 2. Fetch Teacher Shared Boards from Firestore (supporting multi-class targetClasses)
        const teacherQuery = query(collection(db, "boards"), where("isShared", "==", true));
        const teacherSnap = await getDocs(teacherQuery);
        teacherBoardsList = [];
        teacherSnap.forEach(docSnap => {
            const data = docSnap.data();
            const targets = Array.isArray(data.targetClasses) && data.targetClasses.length > 0
                ? data.targetClasses
                : (data.targetClass ? data.targetClass.split(',').map(s => s.trim()) : ['All']);
            const studentClass = (currentUser.studentClass || '').trim();
            const isMatch = currentUser.type === 'staff' || targets.includes('All') || targets.some(t => t.toLowerCase() === studentClass.toLowerCase());
            if (isMatch) {
                teacherBoardsList.push({ id: docSnap.id, ...data });
            }
        });

        // 3. If teacher/staff, fetch boards shared by students for feedback/review
        if (currentUser.type === 'staff') {
            try {
                const studentQuery = query(collection(db, "boards"), where("isSharedWithTeacher", "==", true));
                const studentSnap = await getDocs(studentQuery);
                studentSharedBoardsList = [];
                const teacherEmail = (currentUser.email || '').toLowerCase().trim();
                const teacherUid = (currentUser.uid || '').toLowerCase().trim();
                const isAdmin = currentUser.role === 'admin';

                studentSnap.forEach(docSnap => {
                    const data = docSnap.data();
                    const sharedList = Array.isArray(data.sharedWithTeachers)
                        ? data.sharedWithTeachers.map(x => String(x).toLowerCase().trim())
                        : [];
                    // Admin can access everything; teachers can ONLY access boards explicitly shared with them
                    const isForMe = isAdmin || (
                        (teacherEmail && sharedList.includes(teacherEmail)) ||
                        (teacherUid && sharedList.includes(teacherUid))
                    );
                    if (isForMe) {
                        studentSharedBoardsList.push({ id: docSnap.id, ...data });
                    }
                });

                studentSharedBoardsList.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
                if (studentSharedCount) studentSharedCount.innerText = studentSharedBoardsList.length;
            } catch (err) {
                console.warn("Student shared boards fetch error:", err);
            }
        }

        // Sort boards by latest update
        myBoardsList.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
        teacherBoardsList.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

        if (myCount) myCount.innerText = myBoardsList.length;
        if (teacherCount) teacherCount.innerText = teacherBoardsList.length;

        renderHubBoardsGrid();
    } catch (err) {
        console.warn("Firestore boards fetch error:", err);
        renderHubBoardsGrid();
    }
}

function renderHubBoardsGrid() {
    const myGrid = document.getElementById('myBoardsGrid');
    const teacherGrid = document.getElementById('teacherBoardsGrid');
    const studentSharedGrid = document.getElementById('studentSharedBoardsGrid');
    if (!myGrid || !teacherGrid) return;

    if (activeTab === 'my-boards') {
        myGrid.classList.remove('hidden');
        teacherGrid.classList.add('hidden');
        if (studentSharedGrid) studentSharedGrid.classList.add('hidden');

        if (myBoardsList.length === 0) {
            myGrid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 48px 20px; text-align: center; color: var(--text-gray);">
                    <div style="width: 54px; height: 54px; margin: 0 auto 12px auto; border-radius: 14px; background: rgba(30,94,255,0.08); display: flex; align-items: center; justify-content: center; color: #1e5eff;">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            <line x1="8" y1="12" x2="16" y2="12"></line>
                            <line x1="12" y1="8" x2="12" y2="16"></line>
                        </svg>
                    </div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: var(--text-dark);">No Boards Created Yet</h3>
                    <p style="margin: 4px 0 16px 0; font-size: 13px;">Create your first personal board to get started!</p>
                    <button class="board-create-btn" onclick="window.createNewBoard('Blank Board')">+ New Blank Board</button>
                </div>
            `;
            return;
        }

        myGrid.innerHTML = myBoardsList.map(b => `
            <div class="board-item-card" onclick="window.openBoardEditor('${b.id}')">
                <div class="board-thumb-area" style="background: rgba(30, 94, 255, 0.04); display: flex; align-items: center; justify-content: center;">
                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#1e5eff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="3" y1="9" x2="21" y2="9"></line>
                        <line x1="9" y1="21" x2="9" y2="9"></line>
                    </svg>
                </div>
                <div class="board-card-body">
                    <div class="board-card-title-row">
                        <h4 class="board-card-title">${escapeHtml(b.title || 'Untitled Board')}</h4>
                        ${b.isShared ? `<span class="board-badge-shared">Shared (${escapeHtml(Array.isArray(b.targetClasses) ? b.targetClasses.join(', ') : (b.targetClass || 'All'))})</span>` : ''}
                        ${b.isSharedWithTeacher ? `<span class="board-badge-shared" style="background: rgba(16, 185, 129, 0.1); color: #059669;">Shared with Teacher</span>` : ''}
                    </div>
                    <div class="board-card-meta">
                        <span>${formatDate(b.updatedAt || b.createdAt)}</span>
                        <div style="display: flex; gap: 4px;" onclick="event.stopPropagation();">
                            <button class="board-icon-btn" style="width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;" title="Duplicate" onclick="window.duplicateBoard('${b.id}')">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                </svg>
                            </button>
                            <button class="board-icon-btn" style="width: 28px; height: 28px; color: #ef4444; display: inline-flex; align-items: center; justify-content: center;" title="Delete" onclick="window.deleteBoard('${b.id}')">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } else if (activeTab === 'teacher-boards') {
        teacherGrid.classList.remove('hidden');
        myGrid.classList.add('hidden');
        if (studentSharedGrid) studentSharedGrid.classList.add('hidden');

        if (teacherBoardsList.length === 0) {
            teacherGrid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 48px 20px; text-align: center; color: var(--text-gray);">
                    <div style="width: 54px; height: 54px; margin: 0 auto 12px auto; border-radius: 14px; background: rgba(30,94,255,0.08); display: flex; align-items: center; justify-content: center; color: #1e5eff;">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 10v6M2 10l10-5 10 5-10 5z"></path>
                            <path d="M6 12v5c3 3 9 3 12 0v-5"></path>
                        </svg>
                    </div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: var(--text-dark);">No Shared Teacher Boards</h3>
                    <p style="margin: 4px 0 0 0; font-size: 13px;">When teachers publish lesson boards for your class, they will appear here.</p>
                </div>
            `;
            return;
        }

        teacherGrid.innerHTML = teacherBoardsList.map(b => `
            <div class="board-item-card" onclick="window.openBoardEditor('${b.id}', true)">
                <div class="board-thumb-area" style="background: rgba(30, 94, 255, 0.06); display: flex; align-items: center; justify-content: center;">
                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 10v6M2 10l10-5 10 5-10 5z"></path>
                        <path d="M6 12v5c3 3 9 3 12 0v-5"></path>
                    </svg>
                </div>
                <div class="board-card-body">
                    <div class="board-card-title-row">
                        <h4 class="board-card-title">${escapeHtml(b.title || 'Teacher Board')}</h4>
                        <span class="board-badge-shared" style="background: rgba(30, 94, 255, 0.08); color: #1e5eff;">🔒 View Only</span>
                    </div>
                    <div class="board-card-meta">
                        <span>By ${escapeHtml(b.authorName || 'Teacher')}</span>
                        <button class="board-create-btn" style="padding: 5px 12px; font-size: 11px; display: inline-flex; align-items: center; gap: 5px;" onclick="event.stopPropagation(); window.copyTeacherBoardToMine('${b.id}')">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                            <span>Duplicate to My Boards</span>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    } else if (activeTab === 'student-shared-boards') {
        if (!studentSharedGrid) return;
        studentSharedGrid.classList.remove('hidden');
        myGrid.classList.add('hidden');
        teacherGrid.classList.add('hidden');

        if (studentSharedBoardsList.length === 0) {
            studentSharedGrid.innerHTML = `
                <div style="padding: 48px 20px; text-align: center; color: var(--text-gray);">
                    <div style="width: 54px; height: 54px; margin: 0 auto 12px auto; border-radius: 14px; background: rgba(16,185,129,0.08); display: flex; align-items: center; justify-content: center; color: #059669;">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                        </svg>
                    </div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: var(--text-dark);">No Student Canvases Shared Yet</h3>
                    <p style="margin: 4px 0 0 0; font-size: 13px;">When students share their whiteboard work with you, they will appear here grouped by their classes.</p>
                </div>
            `;
            return;
        }

        // Group students based on their classes!
        const groupedByClass = {};
        studentSharedBoardsList.forEach(b => {
            const cls = (b.studentClass || 'Unassigned').trim();
            if (!groupedByClass[cls]) groupedByClass[cls] = [];
            groupedByClass[cls].push(b);
        });

        // Naturally sort classes
        const sortedClasses = Object.keys(groupedByClass).sort();

        studentSharedGrid.innerHTML = sortedClasses.map(cls => {
            const classBoards = groupedByClass[cls];
            return `
                <div class="student-shared-group">
                    <div class="student-shared-group-header">
                        <div class="student-shared-group-title">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e5eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 21h18"></path>
                                <path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"></path>
                                <path d="M9 9h1"></path>
                                <path d="M9 13h1"></path>
                                <path d="M9 17h1"></path>
                                <path d="M14 9h1"></path>
                                <path d="M14 13h1"></path>
                                <path d="M14 17h1"></path>
                            </svg>
                            <span>${escapeHtml(cls)}</span>
                            <span style="font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 12px; background: rgba(30, 94, 255, 0.1); color: #1e5eff;">
                                ${classBoards.length} ${classBoards.length === 1 ? 'Canvas' : 'Canvases'}
                            </span>
                        </div>
                    </div>
                    <div class="student-cards-grid">
                        ${classBoards.map(b => `
                            <div class="board-item-card" onclick="window.openBoardEditor('${b.id}', false)">
                                <div class="board-thumb-area" style="background: rgba(16, 185, 129, 0.08); display: flex; align-items: center; justify-content: center;">
                                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                        <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                        <polyline points="21 15 16 10 5 21"></polyline>
                                    </svg>
                                </div>
                                <div class="board-card-body">
                                    <div class="board-card-title-row">
                                        <h4 class="board-card-title">${escapeHtml(b.title || 'Student Board')}</h4>
                                    </div>
                                    <div style="font-size: 12.5px; font-weight: 600; color: #1e5eff; margin-top: 2px; display: flex; align-items: center;">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                            <circle cx="12" cy="7" r="4"></circle>
                                        </svg>
                                        <span>${escapeHtml(b.authorName || 'Student')}</span>
                                        <span style="font-size: 11px; opacity: 0.7; margin-left: 4px;">(${escapeHtml(b.authorCode || '')})</span>
                                    </div>
                                    <div class="board-card-meta" style="margin-top: 8px;">
                                        <span>${formatDate(b.updatedAt || b.createdAt)}</span>
                                        <button class="board-create-btn" style="padding: 4px 10px; font-size: 11px;" onclick="event.stopPropagation(); window.openBoardEditor('${b.id}', false)">
                                            Open Canvas
                                        </button>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');
    }
}

function setupHubEventListeners() {
    // Theme toggle
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    function applyBoardTheme(theme) {
        const isDark = theme === 'dark';
        document.body.classList.toggle('dark-theme', isDark);
        document.body.classList.toggle('dark-mode', isDark);
        document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
        document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
    }
    const savedTheme = localStorage.getItem('appTheme') || localStorage.getItem('theme') || 'light';
    applyBoardTheme(savedTheme);

    themeToggleBtn?.addEventListener('click', () => {
        const isDark = !document.body.classList.contains('dark-theme');
        const newTheme = isDark ? 'dark' : 'light';
        localStorage.setItem('appTheme', newTheme);
        localStorage.setItem('theme', newTheme);
        applyBoardTheme(newTheme);
        renderCanvas();
    });

    // Logout (Student & Staff)
    const handleLogout = async () => {
        if (confirm("Are you sure you want to log out?")) {
            if (currentUser?.type === 'staff') {
                try {
                    await signOut(auth);
                } catch (e) {
                    console.warn("SignOut error:", e);
                }
            }
            localStorage.removeItem('loggedInStudentCode');
            localStorage.removeItem('studentCode');
            sessionStorage.removeItem('studentLoggedInSession');
            localStorage.removeItem('studentLoggedInSession');
            sessionStorage.removeItem('studentTimelineSession');
            localStorage.removeItem('studentTimelineSession');
            window.location.href = 'index.html';
        }
    };
    document.getElementById('studentLogoutBtn')?.addEventListener('click', handleLogout);
    document.getElementById('mobileKebabLogoutBtn')?.addEventListener('click', handleLogout);

    document.getElementById('tabMyBoards')?.addEventListener('click', () => {
        activeTab = 'my-boards';
        document.getElementById('tabMyBoards')?.classList.add('active');
        document.getElementById('tabTeacherBoards')?.classList.remove('active');
        document.getElementById('tabStudentSharedBoards')?.classList.remove('active');
        renderHubBoardsGrid();
    });

    document.getElementById('tabTeacherBoards')?.addEventListener('click', () => {
        activeTab = 'teacher-boards';
        document.getElementById('tabTeacherBoards')?.classList.add('active');
        document.getElementById('tabMyBoards')?.classList.remove('active');
        document.getElementById('tabStudentSharedBoards')?.classList.remove('active');
        renderHubBoardsGrid();
    });

    document.getElementById('tabStudentSharedBoards')?.addEventListener('click', () => {
        activeTab = 'student-shared-boards';
        document.getElementById('tabStudentSharedBoards')?.classList.add('active');
        document.getElementById('tabMyBoards')?.classList.remove('active');
        document.getElementById('tabTeacherBoards')?.classList.remove('active');
        renderHubBoardsGrid();
    });

    document.getElementById('btnCreateBlankBoard')?.addEventListener('click', () => {
        window.createNewBoard('Blank Board');
    });
}

// --- 3. TEMPLATES & CREATION ---
window.createNewBoard = async function(templateName = 'Blank Board') {
    if (!currentUser) return;
    const newElements = generateTemplateElements(templateName);
    const newBoardData = {
        title: templateName === 'Blank Board' ? 'Untitled Board' : templateName,
        authorUid: currentUser.uid || '',
        authorCode: currentUser.code || '',
        authorName: currentUser.name || 'Student',
        authorRole: currentUser.role || currentUser.type || 'student',
        studentClass: currentUser.studentClass || 'Unassigned',
        targetClass: 'All',
        isShared: false,
        elements: newElements,
        settings: { gridStyle: 'dots', zoom: 1, panX: 0, panY: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    try {
        const docRef = await addDoc(collection(db, "boards"), newBoardData);
        currentBoardId = docRef.id;
        currentBoard = { id: docRef.id, ...newBoardData };
        openBoardWorkspace(currentBoard);
    } catch (err) {
        alert("Failed to create board in cloud Firestore: " + err.message);
    }
};

function generateTemplateElements(templateName) {
    const timestamp = Date.now();
    switch (templateName) {
        case 'Sticky Brainstorming':
            return [
                { id: `el-${timestamp}-1`, type: 'text', x: 200, y: 80, width: 400, height: 50, text: 'Brainstorming Session', fontSize: 28, fontFamily: 'Outfit, sans-serif', color: '#1e293b', isBold: true },
                { id: `el-${timestamp}-2`, type: 'sticky', x: 100, y: 160, width: 180, height: 160, text: 'Idea 1:\nKey concept or focus point', color: '#fef08a', textColor: '#713f12', rotation: -2 },
                { id: `el-${timestamp}-3`, type: 'sticky', x: 320, y: 160, width: 180, height: 160, text: 'Idea 2:\nSupporting details & examples', color: '#fbcfe8', textColor: '#831843', rotation: 3 },
                { id: `el-${timestamp}-4`, type: 'sticky', x: 540, y: 160, width: 180, height: 160, text: 'Idea 3:\nAction items & next steps', color: '#bbf7d0', textColor: '#14532d', rotation: -1 }
            ];
        case 'Cornell Notes':
            return [
                { id: `el-${timestamp}-1`, type: 'shape', shapeType: 'rectangle', x: 80, y: 80, width: 680, height: 60, fillColor: 'rgba(30, 94, 255, 0.08)', strokeColor: '#1e5eff', strokeWidth: 2, text: 'Topic / Objective:' },
                { id: `el-${timestamp}-2`, type: 'shape', shapeType: 'rectangle', x: 80, y: 160, width: 220, height: 380, fillColor: '#ffffff', strokeColor: '#cbd5e1', strokeWidth: 2, text: 'Key Questions / Cues:\n\n• Point 1\n• Point 2' },
                { id: `el-${timestamp}-3`, type: 'shape', shapeType: 'rectangle', x: 320, y: 160, width: 440, height: 380, fillColor: '#ffffff', strokeColor: '#cbd5e1', strokeWidth: 2, text: 'Notes & Explanations:\n\nDetailed lecture notes, diagrams, and formulas go here.' },
                { id: `el-${timestamp}-4`, type: 'shape', shapeType: 'rectangle', x: 80, y: 560, width: 680, height: 120, fillColor: 'rgba(254, 240, 138, 0.25)', strokeColor: '#fde047', strokeWidth: 2, text: 'Summary:\nBrief synthesis of the main takeaways.' }
            ];
        case 'Mind Map':
            return [
                { id: `el-${timestamp}-1`, type: 'shape', shapeType: 'circle', x: 350, y: 240, width: 160, height: 160, fillColor: '#1e5eff', strokeColor: '#1e40af', strokeWidth: 3, textColor: '#ffffff', text: 'Central Topic' },
                { id: `el-${timestamp}-2`, type: 'shape', shapeType: 'rounded-rect', x: 100, y: 120, width: 140, height: 70, fillColor: '#fbcfe8', strokeColor: '#f472b6', strokeWidth: 2, text: 'Subtopic A' },
                { id: `el-${timestamp}-3`, type: 'shape', shapeType: 'rounded-rect', x: 620, y: 120, width: 140, height: 70, fillColor: '#bbf7d0', strokeColor: '#86efac', strokeWidth: 2, text: 'Subtopic B' },
                { id: `el-${timestamp}-4`, type: 'shape', shapeType: 'rounded-rect', x: 100, y: 380, width: 140, height: 70, fillColor: '#bae6fd', strokeColor: '#7dd3fc', strokeWidth: 2, text: 'Subtopic C' },
                { id: `el-${timestamp}-5`, type: 'shape', shapeType: 'rounded-rect', x: 620, y: 380, width: 140, height: 70, fillColor: '#fed7aa', strokeColor: '#fdba74', strokeWidth: 2, text: 'Subtopic D' }
            ];
        default:
            return [];
    }
}

window.openBoardEditor = async function(boardId, isReadOnly = false) {
    if (!currentUser) {
        alert("Please log in first to access this board.");
        window.location.href = 'index.html';
        return;
    }
    try {
        const snap = await getDoc(doc(db, "boards", boardId));
        if (!snap.exists()) {
            alert("Board not found.");
            return;
        }

        currentBoardId = boardId;
        const data = snap.data();
        const isStaff = currentUser.type === 'staff';
        const isAdmin = isStaff && currentUser.role === 'admin';
        const isOwner = isStaff
            ? (data.authorUid && currentUser.uid && data.authorUid === currentUser.uid)
            : (Boolean(data.authorCode) && Boolean(currentUser.code) && data.authorCode === currentUser.code);

        // --- STRICT PERMISSION ENFORCEMENT ---
        if (isAdmin) {
            // Admin can access everything
        } else if (isOwner) {
            // Board owner always has access
        } else if (isStaff) {
            // Teacher (Staff but not admin and not owner)
            const isStudentBoard = data.authorRole === 'student' || Boolean(data.authorCode);
            if (isStudentBoard) {
                // Only teacher that is explicitly given share can access it
                const teacherEmail = (currentUser.email || '').toLowerCase().trim();
                const teacherUid = (currentUser.uid || '').toLowerCase().trim();
                const sharedList = Array.isArray(data.sharedWithTeachers)
                    ? data.sharedWithTeachers.map(x => String(x).toLowerCase().trim())
                    : [];
                const isSharedWithThisTeacher = Boolean(data.isSharedWithTeacher) && (
                    (teacherEmail && sharedList.includes(teacherEmail)) ||
                    (teacherUid && sharedList.includes(teacherUid))
                );

                if (!isSharedWithThisTeacher) {
                    alert("Access Denied: This student board has not been shared with you.");
                    return;
                }
            } else {
                // Teacher viewing another teacher's lesson board
                if (!data.isShared) {
                    alert("Access Denied: This teacher board is private to its author.");
                    return;
                }
            }
        } else {
            // Student (not owner)
            const isTeacherBoard = data.authorRole === 'teacher' || data.authorRole === 'admin' || Boolean(data.authorUid);
            if (isTeacherBoard) {
                const targets = Array.isArray(data.targetClasses) && data.targetClasses.length > 0
                    ? data.targetClasses
                    : (data.targetClass ? data.targetClass.split(',').map(s => s.trim()) : ['All']);
                const studentClass = (currentUser.studentClass || '').trim().toLowerCase();
                const isTargeted = targets.includes('All') || targets.some(t => t.toLowerCase() === studentClass);

                if (!data.isShared || !isTargeted) {
                    alert("Access Denied: This teacher board is not assigned to your class.");
                    return;
                }
            } else {
                // Another student's board
                alert("Access Denied: You do not have permission to view this board.");
                return;
            }
        }

        // Determine if canvas should be opened in view-only / read-only mode
        // Students cannot edit teacher boards or boards that they do not own!
        const shouldBeReadOnly = isReadOnly || (!isAdmin && !isOwner && !isStaff);
        currentBoard = { id: snap.id, ...data, isReadOnly: shouldBeReadOnly };
        openBoardWorkspace(currentBoard);
    } catch (err) {
        alert("Could not load board: " + err.message);
    }
};

window.duplicateBoard = async function(boardId) {
    try {
        const snap = await getDoc(doc(db, "boards", boardId));
        if (snap.exists()) {
            const data = snap.data();
            const copyData = {
                ...data,
                title: `${data.title} (Copy)`,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            await addDoc(collection(db, "boards"), copyData);
            loadBoards();
        }
    } catch (err) {
        alert("Duplicate error: " + err.message);
    }
};

window.copyTeacherBoardToMine = async function(boardId) {
    if (!currentUser) {
        alert("Please log in to duplicate boards.");
        return;
    }
    try {
        const snap = await getDoc(doc(db, "boards", boardId));
        if (snap.exists()) {
            const data = snap.data();
            const myCopy = {
                ...data,
                title: `My Copy - ${data.title || 'Teacher Board'}`,
                authorUid: currentUser.uid || '',
                authorCode: currentUser.code || '',
                authorName: currentUser.name || 'Student',
                authorRole: 'student',
                studentClass: currentUser.studentClass || 'Unassigned',
                isShared: false,
                isSharedWithTeacher: false,
                sharedWithTeachers: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            const newDoc = await addDoc(collection(db, "boards"), myCopy);
            alert("✓ Board duplicated to your personal boards! You can now freely edit your copy.");
            await loadBoards();
            window.openBoardEditor(newDoc.id, false);
        } else {
            alert("Board not found.");
        }
    } catch (err) {
        alert("Copy error: " + err.message);
    }
};

window.deleteBoard = async function(boardId) {
    if (!confirm("Are you sure you want to delete this board?")) return;
    try {
        const snap = await getDoc(doc(db, "boards", boardId));
        if (!snap.exists()) return;
        const data = snap.data();
        const isAdmin = currentUser?.type === 'staff' && currentUser?.role === 'admin';
        const isOwner = currentUser?.type === 'staff'
            ? (data.authorUid && currentUser?.uid && data.authorUid === currentUser.uid)
            : (Boolean(data.authorCode) && Boolean(currentUser?.code) && data.authorCode === currentUser.code);

        if (!isAdmin && !isOwner) {
            alert("You can only delete boards that you own.");
            return;
        }

        await deleteDoc(doc(db, "boards", boardId));
        loadBoards();
    } catch (err) {
        alert("Delete error: " + err.message);
    }
};

// --- 4. WHITEBOARD CANVAS ENGINE ---
function openBoardWorkspace(boardData) {
    document.getElementById('boardHubView')?.classList.add('hidden');
    document.getElementById('boardWorkspaceView')?.classList.remove('hidden');

    elements = Array.isArray(boardData.elements) ? JSON.parse(JSON.stringify(boardData.elements)) : [];
    camera = (boardData.settings && boardData.settings.zoom) 
        ? { x: boardData.settings.panX || 0, y: boardData.settings.panY || 0, zoom: boardData.settings.zoom || 1 }
        : { x: 0, y: 0, zoom: 1 };
    gridStyle = (boardData.settings && boardData.settings.gridStyle) || 'dots';

    undoStack = [];
    redoStack = [];
    selectedElementIds.clear();

    const isReadOnly = Boolean(boardData.isReadOnly);
    const titleInput = document.getElementById('boardTitleInput');
    if (titleInput) {
        titleInput.value = boardData.title || (isReadOnly ? 'Teacher Board' : 'Untitled Board');
        titleInput.readOnly = isReadOnly;
        titleInput.style.cursor = isReadOnly ? 'default' : 'text';
    }

    // Configure Topbar UI for View-Only vs Editable
    const dupBtn = document.getElementById('btnDuplicateReadOnlyBoard');
    if (dupBtn) dupBtn.classList.toggle('hidden', !isReadOnly);

    const editControls = [
        document.getElementById('btnUndo'),
        document.getElementById('btnRedo'),
        document.getElementById('btnClearBoard'),
        document.getElementById('btnSaveBoard'),
        document.getElementById('btnShareBoardToggle'),
        document.querySelector('.board-topbar-divider')
    ];
    editControls.forEach(btn => {
        if (btn) btn.classList.toggle('hidden', isReadOnly);
    });

    const syncStatus = document.getElementById('boardSyncStatus');
    if (syncStatus) {
        if (isReadOnly) {
            syncStatus.innerHTML = `<span style="background: rgba(239, 68, 68, 0.1); color: #ef4444; padding: 3px 8px; border-radius: 6px; font-weight: 600; font-size: 11px;">🔒 View Only (Teacher Board)</span>`;
        } else {
            syncStatus.innerText = '✓ Saved';
        }
    }

    const shareBtn = document.getElementById('btnShareBoardToggle');
    if (shareBtn && currentUser?.type === 'staff') {
        shareBtn.classList.toggle('active', Boolean(boardData.isShared));
    }

    // Configure Tool Dock for View-Only vs Editable
    const toolsDock = document.querySelector('.board-tools-dock');
    if (toolsDock) {
        const creationTools = toolsDock.querySelectorAll('.tool-btn:not([data-tool="pan"]), .tool-divider');
        creationTools.forEach(el => el.classList.toggle('hidden', isReadOnly));
    }

    const fmtBar = document.getElementById('boardFormattingBar');
    if (fmtBar) fmtBar.classList.add('hidden');

    if (isReadOnly) {
        setWhiteboardTool('pan');
        const surf = document.getElementById('boardCanvasSurface');
        if (surf) surf.style.cursor = 'grab';
    } else {
        setWhiteboardTool('select');
    }

    updateGridClass();
    updateZoomDisplay();

    // Safely preload fonts used in this board
    elements.forEach(el => {
        if (el.fontFamily) ensureFontLoaded(el.fontFamily);
    });

    renderCanvas();
}

window.closeBoardWorkspace = function() {
    if (hasUnsavedChanges && !currentBoard?.isReadOnly) {
        saveCurrentBoardDirectly();
    }
    hasUnsavedChanges = false;
    document.getElementById('boardWorkspaceView')?.classList.add('hidden');
    document.getElementById('boardHubView')?.classList.remove('hidden');
    loadBoards();
};

// --- SHARE MODAL & MULTI-CLASS / TEACHER SHARING LOGIC ---
async function loadTeachersForShare() {
    if (availableTeachersList.length > 0) return availableTeachersList;
    try {
        const usersSnap = await getDocs(collection(db, "users"));
        availableTeachersList = [];
        usersSnap.forEach(docSnap => {
            const d = docSnap.data();
            if (d.role === 'teacher' || d.type === 'staff') {
                const name = d.name || (d.email ? d.email.split('@')[0] : 'Teacher');
                availableTeachersList.push({
                    id: docSnap.id,
                    name: name,
                    email: (d.email || '').trim(),
                    subject: d.subject || 'Teacher'
                });
            }
        });
        return availableTeachersList;
    } catch (e) {
        console.warn("Load teachers error:", e);
        return [];
    }
}

async function loadDistinctSchoolClasses() {
    try {
        const studentsSnap = await getDocs(collection(db, "students"));
        const set = new Set(schoolClassesList);
        studentsSnap.forEach(snap => {
            const d = snap.data();
            const cls = (d.studentClass || d.class || '').trim();
            if (cls) set.add(cls);
        });
        schoolClassesList = Array.from(set).sort();
    } catch (e) {
        console.warn("Load classes error:", e);
    }
}

async function openBoardShareModal() {
    if (currentBoard?.isReadOnly) {
        alert("Teacher lesson boards are view-only and cannot be shared.");
        return;
    }
    const modal = document.getElementById('boardShareModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const isStaff = currentUser?.type === 'staff';
    const studentSection = document.getElementById('studentShareWithTeacherSection');
    const teacherSection = document.getElementById('teacherShareWithClassesSection');

    if (studentSection) studentSection.classList.toggle('hidden', isStaff);
    if (teacherSection) teacherSection.classList.toggle('hidden', !isStaff);

    if (!isStaff) {
        // Student view: populate teachers dropdown
        const teacherSelect = document.getElementById('shareTeacherSelect');
        if (teacherSelect) {
            teacherSelect.innerHTML = `<option value="">Loading teachers from database...</option>`;
            const teachers = await loadTeachersForShare();
            if (teachers.length === 0) {
                teacherSelect.innerHTML = `<option value="">No teachers found in database</option>`;
            } else {
                teacherSelect.innerHTML = `<option value="">-- Select a Teacher --</option>` +
                    teachers.map(t => `<option value="${escapeHtml(t.email || t.id)}">${escapeHtml(t.name)} (${escapeHtml(t.subject)})</option>`).join('');
            }
        }
        renderSharedTeachersPills();
    } else {
        // Teacher view: populate class checkboxes
        await loadDistinctSchoolClasses();
        renderTeacherClassCheckboxes();
    }
}

function closeBoardShareModal() {
    document.getElementById('boardShareModal')?.classList.add('hidden');
    const tStat = document.getElementById('shareTeacherStatus');
    if (tStat) tStat.classList.add('hidden');
    const cStat = document.getElementById('teacherShareStatus');
    if (cStat) cStat.classList.add('hidden');
}

function renderSharedTeachersPills() {
    const container = document.getElementById('sharedTeachersListContainer');
    const pillsWrap = document.getElementById('sharedTeachersPills');
    if (!container || !pillsWrap) return;

    const list = Array.isArray(currentBoard?.sharedWithTeachers) ? currentBoard.sharedWithTeachers : [];
    if (list.length === 0) {
        container.classList.add('hidden');
        pillsWrap.innerHTML = '';
        return;
    }

    container.classList.remove('hidden');
    pillsWrap.innerHTML = list.map(item => {
        const found = availableTeachersList.find(t => t.email === item || t.id === item);
        const label = found ? found.name : item;
        return `
            <span class="teacher-shared-pill">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
                    <path d="M22 10v6M2 10l10-5 10 5-10 5z"></path>
                    <path d="M6 12v5c3 3 9 3 12 0v-5"></path>
                </svg>
                <span>${escapeHtml(label)}</span>
                <span style="cursor: pointer; opacity: 0.7; margin-left: 4px;" title="Remove" onclick="window.removeSharedTeacher('${escapeHtml(item)}')">✕</span>
            </span>
        `;
    }).join('');
}

function renderTeacherClassCheckboxes() {
    const grid = document.getElementById('teacherClassCheckboxes');
    const pubToggle = document.getElementById('teacherPublishToggle');
    if (!grid) return;

    if (pubToggle) {
        pubToggle.checked = Boolean(currentBoard?.isShared);
    }

    const currentTargets = Array.isArray(currentBoard?.targetClasses) && currentBoard.targetClasses.length > 0
        ? currentBoard.targetClasses
        : (currentBoard?.targetClass ? currentBoard.targetClass.split(',').map(s => s.trim()) : ['All']);

    const isAll = currentTargets.includes('All');

    grid.innerHTML = `
        <label class="class-checkbox-label" style="grid-column: 1 / -1; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 4px;">
            <input type="checkbox" id="chkClassAll" value="All" ${isAll ? 'checked' : ''} onchange="window.onClassAllToggle(this)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 4px 0 2px;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            <span>All Classes (Entire School)</span>
        </label>
        ${schoolClassesList.map(cls => {
            const isChecked = !isAll && currentTargets.includes(cls);
            return `
                <label class="class-checkbox-label">
                    <input type="checkbox" class="chk-class-item" value="${escapeHtml(cls)}" ${isChecked ? 'checked' : ''} ${isAll ? 'disabled' : ''}>
                    <span>${escapeHtml(cls)}</span>
                </label>
            `;
        }).join('')}
    `;
}

window.onClassAllToggle = function(allChk) {
    document.querySelectorAll('.chk-class-item').forEach(chk => {
        chk.disabled = allChk.checked;
        if (allChk.checked) chk.checked = false;
    });
};

window.removeSharedTeacher = async function(teacherIdent) {
    if (!currentBoard || !currentBoardId) return;
    const list = Array.isArray(currentBoard.sharedWithTeachers) ? currentBoard.sharedWithTeachers : [];
    currentBoard.sharedWithTeachers = list.filter(x => x !== teacherIdent);
    if (currentBoard.sharedWithTeachers.length === 0) {
        currentBoard.isSharedWithTeacher = false;
    }
    await updateDoc(doc(db, "boards", currentBoardId), {
        sharedWithTeachers: currentBoard.sharedWithTeachers,
        isSharedWithTeacher: currentBoard.isSharedWithTeacher,
        updatedAt: new Date().toISOString()
    });
    renderSharedTeachersPills();
};

function updateGridClass() {
    const canvasEl = document.getElementById('boardCanvasSurface');
    if (!canvasEl) return;
    canvasEl.className = 'board-canvas-surface ' + (gridStyle === 'dots' ? 'grid-dots' : (gridStyle === 'lines' ? 'grid-lines' : ''));
}

function updateZoomDisplay() {
    const zoomVal = document.getElementById('boardZoomValue');
    if (zoomVal) zoomVal.innerText = `${Math.round(camera.zoom * 100)}%`;
}

function renderCanvas() {
    const canvas = document.getElementById('whiteboardCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Resize canvas to full surface container
    const surface = document.getElementById('boardCanvasSurface');
    if (!surface) return;
    const dpr = window.devicePixelRatio || 1;
    const width = surface.clientWidth;
    const height = surface.clientHeight;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Apply Camera Transform
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // Render elements in order
    elements.forEach(el => {
        renderElement(ctx, el);
    });

    // Render active drawing stroke
    if (isDrawing && currentDrawPoints.length > 1) {
        const strokeColor = activeTool === 'highlighter' ? activeHighlighterColor : activePenColor;
        const strokeSize = activeTool === 'highlighter' ? activeHighlighterSize : activePenSize;
        renderStrokePoints(ctx, currentDrawPoints, strokeColor, strokeSize, activeTool === 'highlighter');
    }

    // Render in-progress connector line / arrow
    if (isConnectingLine && currentLineStart && currentLineEnd) {
        ctx.save();
        ctx.strokeStyle = activeLineColor || '#1e5eff';
        ctx.lineWidth = activeLineWidth || 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(currentLineStart.x, currentLineStart.y);
        ctx.lineTo(currentLineEnd.x, currentLineEnd.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (activeTool === 'arrow') {
            drawArrowHead(ctx, currentLineStart.x, currentLineStart.y, currentLineEnd.x, currentLineEnd.y, 12 + (activeLineWidth || 2.5) * 1.5);
        }
        ctx.restore();
    }

    // Render magnet points when line/arrow tool is active or resizing an endpoint
    if (activeTool === 'line' || activeTool === 'arrow' || isConnectingLine || (isResizing && (activeResizeHandle === 'start' || activeResizeHandle === 'end'))) {
        renderMagnetPoints(ctx, hoveredMagnet);
    }

    // Render Selection Outlines & Bounding Boxes
    if (selectedElementIds.size > 0) {
        renderSelectionBoxes(ctx);
    }

    ctx.restore();

    updateFormattingBar();
}

function renderElement(ctx, el) {
    ctx.save();
    const elX = el.x || 0;
    const elY = el.y || 0;
    const elW = el.width || 0;
    const elH = el.height || 0;

    if (el.rotation) {
        ctx.translate(elX + elW / 2, elY + elH / 2);
        ctx.rotate((el.rotation * Math.PI) / 180);
        ctx.translate(-(elX + elW / 2), -(elY + elH / 2));
    }

    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;

    switch (el.type) {
        case 'sticky':
            renderStickyNote(ctx, el);
            break;
        case 'shape':
            renderShape(ctx, el);
            break;
        case 'text':
            renderRichText(ctx, el);
            break;
        case 'draw':
            renderStrokePoints(ctx, el.points, el.color, el.size, el.isHighlighter);
            break;
        case 'line':
        case 'arrow':
            renderLineOrArrow(ctx, el);
            break;
        case 'image':
            renderImageElement(ctx, el);
            break;
    }

    ctx.restore();
}

function renderStrokePoints(ctx, points, color, size, isHighlighter) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
        const midX = (points[i - 1].x + points[i].x) / 2;
        const midY = (points[i - 1].y + points[i].y) / 2;
        ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, midX, midY);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);

    if (isHighlighter) {
        ctx.strokeStyle = color || '#fef08a';
        ctx.globalAlpha = 0.38;
        ctx.lineWidth = (size || 14) * 2;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'bevel';
    } else {
        ctx.strokeStyle = color || '#1e293b';
        ctx.lineWidth = size || 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }
    ctx.stroke();
    ctx.restore();
}

const imageCache = new Map();

function renderImageElement(ctx, el) {
    const w = el.width || 300;
    const h = el.height || 200;
    const src = el.url || el.src;
    if (!src) return;

    let img = imageCache.get(src);
    if (!img) {
        img = new Image();
        img.crossOrigin = "anonymous";
        img.src = src;
        img.onload = () => {
            renderCanvas();
        };
        imageCache.set(src, img);
    }

    ctx.save();
    if (img.complete && img.naturalWidth > 0) {
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(el.x, el.y, w, h, 8);
        } else {
            ctx.rect(el.x, el.y, w, h);
        }
        ctx.clip();
        ctx.drawImage(img, el.x, el.y, w, h);
    } else {
        ctx.fillStyle = 'rgba(226, 232, 240, 0.7)';
        ctx.fillRect(el.x, el.y, w, h);
        ctx.fillStyle = '#64748b';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading image...', el.x + w / 2, el.y + h / 2);
    }
    ctx.restore();

    if (el.isUploading) {
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.fillRect(el.x, el.y + h - 26, w, 26);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('☁ Uploading to Drive (TimelineDB)...', el.x + w / 2, el.y + h - 9);
        ctx.restore();
    }
}

function renderRichText(ctx, el) {
    if (editingElementId === el.id) return; // Hidden while editing in-place
    const isBold = el.isBold ? 'bold ' : '';
    const isItalic = el.isItalic ? 'italic ' : '';
    const fontSize = el.fontSize || 20;
    const fontFamily = el.fontFamily || "'Outfit', sans-serif";
    ctx.fillStyle = el.color || el.textColor || '#0f172a';
    ctx.font = `${isBold}${isItalic}${fontSize}px ${fontFamily}`;
    wrapText(ctx, el.text || '', el.x, el.y + fontSize * 0.9, el.width || 260, fontSize * 1.35, el.textAlign === 'center');
}

function renderStickyNote(ctx, el) {
    const w = el.width || 180;
    const h = el.height || 160;
    const bg = el.color || '#fef08a';
    const textColor = el.textColor || '#713f12';

    // Drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;

    // Sticky Body
    ctx.fillStyle = bg;
    roundRect(ctx, el.x, el.y, w, h, 8, true, false);

    ctx.shadowColor = 'transparent';

    // Top Tape Pin effect
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    roundRect(ctx, el.x + w / 2 - 20, el.y - 4, 40, 10, 3, true, false);

    // Text Content inside sticky (suppress when actively editing in-place to avoid ghosting)
    if (editingElementId !== el.id) {
        ctx.fillStyle = textColor;
        const isBold = el.isBold ? 'bold ' : '';
        const isItalic = el.isItalic ? 'italic ' : '';
        const fontSize = el.fontSize || 16;
        const fontFamily = el.fontFamily || "'Caveat', cursive, sans-serif";
        ctx.font = `${isBold}${isItalic}${fontSize}px ${fontFamily}`;
        wrapText(ctx, el.text || '', el.x + 14, el.y + 26, w - 28, fontSize * 1.35, el.textAlign === 'center');
    }
}

function renderShape(ctx, el) {
    const w = el.width || 120;
    const h = el.height || 80;
    ctx.fillStyle = el.fillColor || 'rgba(30, 94, 255, 0.1)';
    ctx.strokeStyle = el.strokeColor || '#1e5eff';
    ctx.lineWidth = el.strokeWidth || 2;

    ctx.beginPath();
    switch (el.shapeType) {
        case 'circle':
            ctx.ellipse(el.x + w / 2, el.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
            break;
        case 'pill':
            roundRect(ctx, el.x, el.y, w, h, Math.min(w, h) / 2, false, false);
            break;
        case 'diamond':
            ctx.moveTo(el.x + w / 2, el.y);
            ctx.lineTo(el.x + w, el.y + h / 2);
            ctx.lineTo(el.x + w / 2, el.y + h);
            ctx.lineTo(el.x, el.y + h / 2);
            ctx.closePath();
            break;
        case 'parallelogram': {
            const slant = w * 0.22;
            ctx.moveTo(el.x + slant, el.y);
            ctx.lineTo(el.x + w, el.y);
            ctx.lineTo(el.x + w - slant, el.y + h);
            ctx.lineTo(el.x, el.y + h);
            ctx.closePath();
            break;
        }
        case 'cylinder': {
            const ry = Math.min(16, h * 0.2);
            ctx.moveTo(el.x, el.y + ry);
            ctx.lineTo(el.x, el.y + h - ry);
            ctx.bezierCurveTo(el.x, el.y + h, el.x + w, el.y + h, el.x + w, el.y + h - ry);
            ctx.lineTo(el.x + w, el.y + ry);
            ctx.bezierCurveTo(el.x + w, el.y, el.x, el.y, el.x, el.y + ry);
            ctx.closePath();
            break;
        }
        case 'hexagon': {
            const hx = w * 0.22;
            ctx.moveTo(el.x + hx, el.y);
            ctx.lineTo(el.x + w - hx, el.y);
            ctx.lineTo(el.x + w, el.y + h / 2);
            ctx.lineTo(el.x + w - hx, el.y + h);
            ctx.lineTo(el.x + hx, el.y + h);
            ctx.lineTo(el.x, el.y + h / 2);
            ctx.closePath();
            break;
        }
        case 'document': {
            ctx.moveTo(el.x, el.y);
            ctx.lineTo(el.x + w, el.y);
            ctx.lineTo(el.x + w, el.y + h - 14);
            ctx.bezierCurveTo(el.x + w * 0.75, el.y + h - 26, el.x + w * 0.25, el.y + h + 2, el.x, el.y + h - 14);
            ctx.closePath();
            break;
        }
        case 'star':
            drawStarPath(ctx, el.x + w / 2, el.y + h / 2, 5, w / 2, w / 4);
            break;
        case 'triangle':
            ctx.moveTo(el.x + w / 2, el.y);
            ctx.lineTo(el.x + w, el.y + h);
            ctx.lineTo(el.x, el.y + h);
            ctx.closePath();
            break;
        case 'cloud':
            drawCloudPath(ctx, el.x, el.y, w, h);
            break;
        case 'bubble':
            drawSpeechBubblePath(ctx, el.x, el.y, w, h);
            break;
        case 'block-arrow': {
            const headW = w * 0.35;
            const shaftH = h * 0.45;
            const shaftY = el.y + (h - shaftH) / 2;
            ctx.moveTo(el.x, shaftY);
            ctx.lineTo(el.x + w - headW, shaftY);
            ctx.lineTo(el.x + w - headW, el.y);
            ctx.lineTo(el.x + w, el.y + h / 2);
            ctx.lineTo(el.x + w - headW, el.y + h);
            ctx.lineTo(el.x + w - headW, shaftY + shaftH);
            ctx.lineTo(el.x, shaftY + shaftH);
            ctx.closePath();
            break;
        }
        case 'rounded-rect':
            roundRect(ctx, el.x, el.y, w, h, 14, false, false);
            break;
        case 'rectangle':
        default:
            ctx.rect(el.x, el.y, w, h);
            break;
    }

    if (el.fillColor && el.fillColor !== 'transparent') ctx.fill();
    if (el.strokeColor && el.strokeColor !== 'transparent' && el.strokeWidth > 0) ctx.stroke();

    // Extra Cylinder top rim
    if (el.shapeType === 'cylinder') {
        const ry = Math.min(16, h * 0.2);
        ctx.beginPath();
        ctx.ellipse(el.x + w / 2, el.y + ry, w / 2, ry, 0, 0, Math.PI * 2);
        if (el.fillColor && el.fillColor !== 'transparent') ctx.fill();
        if (el.strokeColor && el.strokeColor !== 'transparent' && el.strokeWidth > 0) ctx.stroke();
    }

    // Center Text in shape if any (suppress when actively editing in-place)
    if (el.text && editingElementId !== el.id) {
        ctx.fillStyle = el.textColor || '#0f172a';
        const isBold = el.isBold ? 'bold ' : '';
        const isItalic = el.isItalic ? 'italic ' : '';
        const fontSize = el.fontSize || 15;
        const fontFamily = el.fontFamily || "'Inter', sans-serif";
        ctx.font = `${isBold}${isItalic}${fontSize}px ${fontFamily}`;
        wrapText(ctx, el.text, el.x + 10, el.y + h / 2 - 6, w - 20, fontSize * 1.35, el.textAlign !== 'left');
    }
}

function drawCloudPath(ctx, x, y, w, h) {
    ctx.moveTo(x + w * 0.2, y + h * 0.7);
    ctx.bezierCurveTo(x, y + h * 0.7, x, y + h * 0.35, x + w * 0.2, y + h * 0.35);
    ctx.bezierCurveTo(x + w * 0.15, y + h * 0.1, x + w * 0.45, y + h * 0.05, x + w * 0.5, y + h * 0.25);
    ctx.bezierCurveTo(x + w * 0.65, y + h * 0.05, x + w * 0.85, y + h * 0.15, x + w * 0.8, y + h * 0.4);
    ctx.bezierCurveTo(x + w * 1.05, y + h * 0.45, x + w * 1.02, y + h * 0.75, x + w * 0.8, y + h * 0.75);
    ctx.closePath();
}

function getShapeAnchorCoord(shape, anchorId) {
    const w = shape.width || 120;
    const h = shape.height || 80;
    switch (anchorId) {
        case 'top':
            return { x: shape.x + w / 2, y: shape.y };
        case 'right':
            return { x: shape.x + w, y: shape.y + h / 2 };
        case 'bottom':
            return { x: shape.x + w / 2, y: shape.y + h };
        case 'left':
        default:
            return { x: shape.x, y: shape.y + h / 2 };
    }
}

function getShapeMagnetPoints(shape) {
    return [
        { id: 'top', ...getShapeAnchorCoord(shape, 'top'), shapeId: shape.id },
        { id: 'right', ...getShapeAnchorCoord(shape, 'right'), shapeId: shape.id },
        { id: 'bottom', ...getShapeAnchorCoord(shape, 'bottom'), shapeId: shape.id },
        { id: 'left', ...getShapeAnchorCoord(shape, 'left'), shapeId: shape.id }
    ];
}

function findNearestMagnetPoint(wx, wy, snapRadius = 24) {
    for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        if (el.type !== 'shape' && el.type !== 'sticky' && el.type !== 'image') continue;
        const magnets = getShapeMagnetPoints(el);
        for (const m of magnets) {
            if (Math.hypot(wx - m.x, wy - m.y) <= snapRadius) {
                return m;
            }
        }
    }
    return null;
}

function getLineEndpoints(el) {
    let x1 = el.x1 !== undefined ? el.x1 : el.x;
    let y1 = el.y1 !== undefined ? el.y1 : el.y;
    let x2 = el.x2 !== undefined ? el.x2 : (el.x + (el.width || 100));
    let y2 = el.y2 !== undefined ? el.y2 : (el.y + (el.height || 0));

    if (el.startBinding) {
        const shape = elements.find(item => item.id === el.startBinding.shapeId);
        if (shape) {
            const pt = getShapeAnchorCoord(shape, el.startBinding.anchor);
            x1 = pt.x;
            y1 = pt.y;
        }
    }

    if (el.endBinding) {
        const shape = elements.find(item => item.id === el.endBinding.shapeId);
        if (shape) {
            const pt = getShapeAnchorCoord(shape, el.endBinding.anchor);
            x2 = pt.x;
            y2 = pt.y;
        }
    }

    return { x1, y1, x2, y2 };
}

function renderLineOrArrow(ctx, el) {
    const ep = getLineEndpoints(el);
    ctx.save();
    ctx.strokeStyle = el.strokeColor || '#1e5eff';
    ctx.lineWidth = el.strokeWidth || 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(ep.x1, ep.y1);
    ctx.lineTo(ep.x2, ep.y2);
    ctx.stroke();

    if (el.type === 'arrow') {
        drawArrowHead(ctx, ep.x1, ep.y1, ep.x2, ep.y2, 12 + (el.strokeWidth || 2.5) * 1.5);
    }
    ctx.restore();
}

function renderMagnetPoints(ctx, highlightMagnet = null) {
    elements.forEach(el => {
        if (el.type !== 'shape' && el.type !== 'sticky' && el.type !== 'image') return;
        const magnets = getShapeMagnetPoints(el);
        magnets.forEach(m => {
            const isHighlighted = highlightMagnet && highlightMagnet.shapeId === el.id && highlightMagnet.id === m.id;
            ctx.save();
            ctx.beginPath();
            ctx.arc(m.x, m.y, isHighlighted ? 7 : 4.5, 0, Math.PI * 2);
            ctx.fillStyle = isHighlighted ? '#06b6d4' : 'rgba(14, 165, 233, 0.45)';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = isHighlighted ? 2.5 : 1.5;
            ctx.stroke();
            if (isHighlighted) {
                ctx.beginPath();
                ctx.arc(m.x, m.y, 11, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            ctx.restore();
        });
    });
}

function getResizeHandles(el) {
    if (el.type === 'line' || el.type === 'arrow') {
        const ep = getLineEndpoints(el);
        return [
            { handle: 'start', x: ep.x1, y: ep.y1, cursor: 'crosshair' },
            { handle: 'end', x: ep.x2, y: ep.y2, cursor: 'crosshair' }
        ];
    }
    const pad = 6;
    const x = el.x - pad;
    const y = el.y - pad;
    const w = (el.width || 120) + pad * 2;
    const h = (el.height || 80) + pad * 2;
    return [
        { handle: 'nw', x: x, y: y, cursor: 'nwse-resize' },
        { handle: 'ne', x: x + w, y: y, cursor: 'nesw-resize' },
        { handle: 'se', x: x + w, y: y + h, cursor: 'nwse-resize' },
        { handle: 'sw', x: x, y: y + h, cursor: 'nesw-resize' }
    ];
}

function findResizeHandleHit(wx, wy) {
    if (selectedElementIds.size !== 1) return null;
    const el = elements.find(item => selectedElementIds.has(item.id));
    if (!el || el.type === 'draw') return null;
    const handles = getResizeHandles(el);
    const hitRadius = 14 / camera.zoom;
    for (const h of handles) {
        if (Math.hypot(wx - h.x, wy - h.y) <= hitRadius) {
            return { handle: h.handle, element: el, cursor: h.cursor };
        }
    }
    return null;
}

const loadedFonts = new Set([
    'Caveat', 'Inter', 'Merriweather', 'Roboto Mono', 'Outfit', 'sans-serif', 'serif', 'monospace', 'cursive'
]);
const loadingFonts = new Set();

function ensureFontLoaded(fontFamily) {
    if (!fontFamily) return;
    const match = fontFamily.match(/'([^']+)'/);
    const cleanFontName = match ? match[1] : fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    if (!cleanFontName || cleanFontName === 'sans-serif' || cleanFontName === 'serif' || cleanFontName === 'monospace') return;

    // If already loaded or currently in-flight, exit immediately to prevent re-render loops!
    if (loadedFonts.has(cleanFontName)) return;
    if (loadingFonts.has(cleanFontName)) return;

    loadingFonts.add(cleanFontName);

    const linkId = `gfont-${cleanFontName.replace(/\s+/g, '-').toLowerCase()}`;
    if (!document.getElementById(linkId)) {
        const link = document.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(cleanFontName)}&display=swap`;
        document.head.appendChild(link);
    }

    if (document.fonts && document.fonts.load) {
        document.fonts.load(`16px "${cleanFontName}"`).then(() => {
            loadedFonts.add(cleanFontName);
            loadingFonts.delete(cleanFontName);
            renderCanvas();
        }).catch(() => {
            loadedFonts.add(cleanFontName);
            loadingFonts.delete(cleanFontName);
        });
    } else {
        loadedFonts.add(cleanFontName);
        loadingFonts.delete(cleanFontName);
    }
}

function renderSelectionBoxes(ctx) {
    selectedElementIds.forEach(id => {
        if (editingElementId === id) return;
        const el = elements.find(item => item.id === id);
        if (!el) return;

        if (el.type === 'line' || el.type === 'arrow') {
            const ep = getLineEndpoints(el);
            const handleRadius = 5.5 / camera.zoom;
            [ { x: ep.x1, y: ep.y1 }, { x: ep.x2, y: ep.y2 } ].forEach(pt => {
                ctx.save();
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = '#1e5eff';
                ctx.lineWidth = 2.5 / camera.zoom;
                ctx.stroke();
                ctx.restore();
            });
            return;
        }

        const pad = 6;
        const x = el.x - pad;
        const y = el.y - pad;
        const w = (el.width || 120) + pad * 2;
        const h = (el.height || 80) + pad * 2;

        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        if (el.type !== 'draw') {
            // Render 4 corner handles (vertices for resizing)
            const handles = getResizeHandles(el);
            const handleSize = 9 / camera.zoom;

            handles.forEach(pt => {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(pt.x - handleSize / 2, pt.y - handleSize / 2, handleSize, handleSize);
                ctx.strokeStyle = '#1e5eff';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.strokeRect(pt.x - handleSize / 2, pt.y - handleSize / 2, handleSize, handleSize);
            });
        }
    });
}

// --- 5. CANVAS EVENT HANDLERS (MOUSE & TOUCH) ---
function setupCanvasEventListeners() {
    const surface = document.getElementById('boardCanvasSurface');
    if (!surface) return;

    surface.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    // Suppress right-click context menu on canvas for hand panning
    surface.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    });

    // Dismiss sub-palettes when clicking anywhere outside
    document.addEventListener('pointerdown', (e) => {
        const inDock = e.target.closest('.board-tools-dock');
        const inSubPalette = e.target.closest('.board-sub-palette');
        const inModal = e.target.closest('.board-share-modal-container');
        const inColorInput = e.target.closest('.native-color-input');
        const inFormatBar = e.target.closest('.board-formatting-bar');
        if (!inDock && !inSubPalette && !inModal && !inColorInput && !inFormatBar) {
            ['stickySubPalette', 'shapeSubPalette', 'penSubPalette', 'lineSubPalette'].forEach(id => {
                document.getElementById(id)?.classList.add('hidden');
            });
        }
    }, true);

    // Touch Support
    surface.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) onPointerDown(touchToMouseEvent(e.touches[0]));
    }, { passive: false });

    surface.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) onPointerMove(touchToMouseEvent(e.touches[0]));
    }, { passive: false });

    surface.addEventListener('touchend', (e) => {
        onPointerUp(e);
    });

    // Zoom on Mouse Wheel
    surface.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        applyZoom(zoomFactor, e.clientX, e.clientY);
    }, { passive: false });

    // Double click to edit sticky or text
    surface.addEventListener('dblclick', (e) => {
        if (currentBoard?.isReadOnly) return; // Prevent editing on teacher boards
        isDragging = false;
        isResizing = false;
        isPanning = false;
        isDrawing = false;
        const pt = screenToWorld(e.clientX, e.clientY);
        const hit = findHitElement(pt.x, pt.y);
        if (hit && (hit.type === 'sticky' || hit.type === 'text' || hit.type === 'shape')) {
            openInPlaceTextEditor(hit);
        }
    });

    // Tool dock buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (currentBoard?.isReadOnly) return; // Lock tools dock in read-only mode
            const tool = btn.getAttribute('data-tool');
            if (tool === 'image') {
                const imgInput = document.getElementById('boardImageFileInput');
                if (imgInput) {
                    imgInput.value = '';
                    imgInput.click();
                }
                return;
            }
            if (tool === 'picker') {
                if (window.EyeDropper) {
                    const eyeDropper = new window.EyeDropper();
                    eyeDropper.open().then(result => {
                        if (result && result.sRGBHex) {
                            applyPickedColor(result.sRGBHex);
                        }
                    }).catch(() => {
                        setWhiteboardTool('picker');
                    });
                    return;
                }
            }
            setWhiteboardTool(tool);
        });
    });

    // Image Upload Input Listener
    const boardImageInput = document.getElementById('boardImageFileInput');
    if (boardImageInput) {
        boardImageInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImageUpload(file);
        });
    }

    // Clipboard Paste support for Images (Ctrl+V)
    window.addEventListener('paste', (e) => {
        if (currentBoard?.isReadOnly) return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type && items[i].type.indexOf('image') !== -1) {
                const file = items[i].getAsFile();
                if (file) {
                    e.preventDefault();
                    handleImageUpload(file);
                    break;
                }
            }
        }
    });

    // Top bar actions
    document.getElementById('btnBoardBack')?.addEventListener('click', window.closeBoardWorkspace);
    document.getElementById('btnDuplicateReadOnlyBoard')?.addEventListener('click', () => {
        if (currentBoardId) {
            window.copyTeacherBoardToMine(currentBoardId);
        }
    });
    document.getElementById('btnUndo')?.addEventListener('click', () => {
        if (currentBoard?.isReadOnly) return;
        window.undo();
    });
    document.getElementById('btnRedo')?.addEventListener('click', () => {
        if (currentBoard?.isReadOnly) return;
        window.redo();
    });
    document.getElementById('btnClearBoard')?.addEventListener('click', () => {
        if (currentBoard?.isReadOnly) return;
        window.clearBoard();
    });
    document.getElementById('btnSaveBoard')?.addEventListener('click', () => {
        if (currentBoard?.isReadOnly) return;
        saveCurrentBoardDirectly();
    });
    document.getElementById('btnExportPng')?.addEventListener('click', window.exportBoardAsPNG);

    // Share Board Modal
    document.getElementById('btnShareBoardToggle')?.addEventListener('click', () => {
        openBoardShareModal();
    });
    document.getElementById('btnCloseShareModal')?.addEventListener('click', closeBoardShareModal);
    document.getElementById('boardShareModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeBoardShareModal();
    });

    // Student Share to Teacher Submit
    document.getElementById('btnShareWithTeacherSubmit')?.addEventListener('click', async () => {
        if (!currentBoard || !currentBoardId) {
            alert("Please create or open a board first!");
            return;
        }
        const select = document.getElementById('shareTeacherSelect');
        const teacherIdent = select?.value;
        if (!teacherIdent) {
            alert("Please select a teacher from the dropdown.");
            return;
        }

        const list = Array.isArray(currentBoard.sharedWithTeachers) ? [...currentBoard.sharedWithTeachers] : [];
        if (!list.includes(teacherIdent)) {
            list.push(teacherIdent);
        }
        currentBoard.sharedWithTeachers = list;
        currentBoard.isSharedWithTeacher = true;

        const teacherObj = availableTeachersList.find(t => t.email === teacherIdent || t.id === teacherIdent);
        const teacherDisplayName = teacherObj ? teacherObj.name : teacherIdent;

        const stat = document.getElementById('shareTeacherStatus');
        if (stat) {
            stat.innerText = 'Sharing board with teacher...';
            stat.classList.remove('hidden');
            stat.style.color = '#1e5eff';
        }

        try {
            await updateDoc(doc(db, "boards", currentBoardId), {
                sharedWithTeachers: list,
                isSharedWithTeacher: true,
                authorName: currentUser.name || 'Student',
                authorCode: currentUser.code || '',
                studentClass: currentUser.studentClass || 'Unassigned',
                updatedAt: new Date().toISOString()
            });

            const shareBtn = document.getElementById('btnShareBoardToggle');
            if (shareBtn) shareBtn.classList.add('active');

            if (stat) {
                stat.innerText = `✓ Successfully shared with ${teacherDisplayName}!`;
                stat.style.color = '#10b981';
            }
            renderSharedTeachersPills();
        } catch (e) {
            if (stat) {
                stat.innerText = '⚠️ Share failed: ' + e.message;
                stat.style.color = '#ef4444';
            }
        }
    });

    // Teacher Save Multi-Class Sharing
    document.getElementById('btnTeacherSaveSharing')?.addEventListener('click', async () => {
        if (!currentBoard || !currentBoardId) return;

        const pubToggle = document.getElementById('teacherPublishToggle');
        const isShared = Boolean(pubToggle?.checked);

        const allChk = document.getElementById('chkClassAll');
        let selectedClasses = [];
        if (allChk && allChk.checked) {
            selectedClasses = ['All'];
        } else {
            document.querySelectorAll('.chk-class-item:checked').forEach(c => {
                selectedClasses.push(c.value);
            });
            if (selectedClasses.length === 0 && isShared) {
                selectedClasses = ['All'];
            }
        }

        currentBoard.isShared = isShared;
        currentBoard.targetClasses = selectedClasses;
        currentBoard.targetClass = selectedClasses.join(', ');

        const stat = document.getElementById('teacherShareStatus');
        if (stat) {
            stat.innerText = 'Saving sharing settings...';
            stat.classList.remove('hidden');
            stat.style.color = '#1e5eff';
        }

        try {
            await updateDoc(doc(db, "boards", currentBoardId), {
                isShared: isShared,
                targetClasses: selectedClasses,
                targetClass: selectedClasses.join(', '),
                updatedAt: new Date().toISOString()
            });

            const shareBtn = document.getElementById('btnShareBoardToggle');
            if (shareBtn) shareBtn.classList.toggle('active', isShared);

            if (stat) {
                stat.innerText = isShared ? `✓ Published to ${selectedClasses.join(', ')}!` : '✓ Board set to private.';
                stat.style.color = '#10b981';
            }
        } catch (e) {
            if (stat) {
                stat.innerText = '⚠️ Save failed: ' + e.message;
                stat.style.color = '#ef4444';
            }
        }
    });

    document.getElementById('boardTitleInput')?.addEventListener('change', (e) => {
        if (currentBoard && !currentBoard.isReadOnly) {
            currentBoard.title = e.target.value.trim() || 'Untitled Board';
            scheduleAutoSave();
        }
    });

    // Zoom Buttons
    document.getElementById('btnZoomIn')?.addEventListener('click', () => applyZoom(1.15));
    document.getElementById('btnZoomOut')?.addEventListener('click', () => applyZoom(0.85));
    document.getElementById('btnZoomReset')?.addEventListener('click', () => {
        camera.zoom = 1;
        updateZoomDisplay();
        renderCanvas();
    });

    // Sticky Color Dots in palette
    document.querySelectorAll('.sticky-color-dot').forEach(dot => {
        dot.addEventListener('click', () => {
            activeStickyColor = dot.getAttribute('data-color') || activeStickyColor;
            document.querySelectorAll('.sticky-color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
        });
    });

    // Custom Sticky Color Picker
    const stickyCustomPicker = document.getElementById('stickyCustomColorPicker');
    const stickyCustomDot = document.getElementById('stickyCustomColorDot');
    if (stickyCustomPicker) {
        stickyCustomPicker.addEventListener('input', (e) => {
            activeStickyColor = e.target.value;
            document.querySelectorAll('.sticky-color-dot').forEach(d => d.classList.remove('active'));
            stickyCustomDot?.classList.add('active');
        });
    }

    // Shape Choices in Shape Sub-palette
    document.querySelectorAll('.shape-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeShapeType = btn.getAttribute('data-shape') || 'rectangle';
            document.querySelectorAll('.shape-choice-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setWhiteboardTool('shape');
        });
    });

    // Custom Pen / Highlighter Color Picker
    const penCustomPicker = document.getElementById('penCustomColorPicker');
    const penCustomDot = document.getElementById('penCustomColorDot');
    if (penCustomPicker) {
        penCustomPicker.addEventListener('input', (e) => {
            const color = e.target.value;
            if (activeTool === 'highlighter') {
                activeHighlighterColor = color;
            } else {
                activePenColor = color;
            }
            document.querySelectorAll('#penColorsContainer .pen-color-dot').forEach(d => d.classList.remove('active'));
            penCustomDot?.classList.add('active');
        });
    }

    // Pen / Highlighter Sizes in Sub-palette
    document.querySelectorAll('.pen-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const size = parseFloat(btn.getAttribute('data-size')) || 4;
            if (activeTool === 'highlighter') {
                activeHighlighterSize = size;
            } else {
                activePenSize = size;
            }
            document.querySelectorAll('.pen-size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // Line Colors in Line Sub-palette (Base 5 colors)
    document.querySelectorAll('.line-color-dot').forEach(dot => {
        dot.addEventListener('click', () => {
            activeLineColor = dot.getAttribute('data-color') || '#1e5eff';
            document.querySelectorAll('.line-color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
        });
    });

    // Custom Line Color Picker
    const lineCustomPicker = document.getElementById('lineCustomColorPicker');
    const lineCustomDot = document.getElementById('lineCustomColorDot');
    if (lineCustomPicker) {
        lineCustomPicker.addEventListener('input', (e) => {
            activeLineColor = e.target.value;
            document.querySelectorAll('.line-color-dot').forEach(d => d.classList.remove('active'));
            lineCustomDot?.classList.add('active');
        });
    }

    // Line Thickness in Line Sub-palette
    document.querySelectorAll('.line-width-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeLineWidth = parseFloat(btn.getAttribute('data-width')) || 2.5;
            document.querySelectorAll('.line-width-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // --- Floating Formatting Toolbar Event Listeners ---
    document.getElementById('fmtFontFamily')?.addEventListener('change', (e) => {
        pushUndoState();
        const newFont = e.target.value;
        ensureFontLoaded(newFont);
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) el.fontFamily = newFont;
        });
        const activeEditor = document.getElementById('boardInPlaceEditor');
        if (activeEditor) {
            activeEditor.style.setProperty('font-family', newFont, 'important');
        }
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtSizeDown')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.fontSize = Math.max(10, (el.fontSize || 16) - 2);
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('font-size', `${el.fontSize * camera.zoom}px`, 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    });

    document.getElementById('fmtSizeUp')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.fontSize = Math.min(72, (el.fontSize || 16) + 2);
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('font-size', `${el.fontSize * camera.zoom}px`, 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    });

    document.getElementById('fmtBold')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.isBold = !el.isBold;
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('font-weight', el.isBold ? '700' : '400', 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    });

    document.getElementById('fmtItalic')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.isItalic = !el.isItalic;
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('font-style', el.isItalic ? 'italic' : 'normal', 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    });

    document.getElementById('fmtAlignLeft')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.textAlign = 'left';
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('text-align', 'left', 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtAlignCenter')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.textAlign = 'center';
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('text-align', 'center', 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtAlignRight')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.textAlign = 'right';
                const activeEditor = document.getElementById('boardInPlaceEditor');
                if (activeEditor && editingElementId === el.id) {
                    activeEditor.style.setProperty('text-align', 'right', 'important');
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
    });

    // Shape / Line / Pen Stroke Thickness controls
    document.getElementById('fmtBorderDown')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                if (el.type === 'draw') {
                    el.size = Math.max(1, (el.size || 4) - 1);
                } else if (el.type === 'line' || el.type === 'arrow') {
                    el.strokeWidth = Math.max(1, (el.strokeWidth !== undefined ? el.strokeWidth : 2.5) - 1);
                } else {
                    el.strokeWidth = Math.max(0, (el.strokeWidth !== undefined ? el.strokeWidth : 2) - 1);
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    });

    document.getElementById('fmtBorderUp')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                if (el.type === 'draw') {
                    el.size = Math.min(30, (el.size || 4) + 1);
                } else if (el.type === 'line' || el.type === 'arrow') {
                    el.strokeWidth = Math.min(24, (el.strokeWidth !== undefined ? el.strokeWidth : 2.5) + 1);
                } else {
                    el.strokeWidth = Math.min(24, (el.strokeWidth !== undefined ? el.strokeWidth : 2) + 1);
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    });

    // Color Popover Toggle
    document.getElementById('fmtColorBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const popover = document.getElementById('fmtColorPopover');
        if (popover) popover.classList.toggle('hidden');
    });

    // Close color popover on outside click
    document.addEventListener('click', (e) => {
        const popover = document.getElementById('fmtColorPopover');
        const colorBtn = document.getElementById('fmtColorBtn');
        if (popover && !popover.contains(e.target) && !colorBtn?.contains(e.target)) {
            popover.classList.add('hidden');
        }
    });

    // Fill Color Swatches (also sets color for draw and line)
    document.querySelectorAll('.fmt-color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            const bg = swatch.getAttribute('data-bg');
            const text = swatch.getAttribute('data-text');
            pushUndoState();
            selectedElementIds.forEach(id => {
                const el = elements.find(item => item.id === id);
                if (el) {
                    if (el.type === 'sticky') {
                        el.color = bg;
                        if (text) el.textColor = text;
                    } else if (el.type === 'shape') {
                        el.fillColor = bg;
                    } else if (el.type === 'text') {
                        el.color = bg;
                        el.textColor = bg;
                    } else if (el.type === 'draw') {
                        el.color = bg;
                    } else if (el.type === 'line' || el.type === 'arrow') {
                        el.strokeColor = bg;
                    }
                }
            });
            document.getElementById('fmtColorPopover')?.classList.add('hidden');
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    });

    // Shape / Line Border Color Swatches
    document.querySelectorAll('.fmt-border-color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            const border = swatch.getAttribute('data-border');
            pushUndoState();
            selectedElementIds.forEach(id => {
                const el = elements.find(item => item.id === id);
                if (el) {
                    if (el.type === 'draw') {
                        el.color = border === 'transparent' ? '#1e293b' : border;
                    } else if (el.type === 'line' || el.type === 'arrow') {
                        el.strokeColor = border === 'transparent' ? '#1e5eff' : border;
                    } else {
                        el.strokeColor = border;
                        if (border === 'transparent') {
                            el.strokeWidth = 0;
                        } else if (!el.strokeWidth || el.strokeWidth === 0) {
                            el.strokeWidth = 2;
                        }
                    }
                }
            });
            document.getElementById('fmtColorPopover')?.classList.add('hidden');
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    });

    // Text Color Swatches
    document.querySelectorAll('.fmt-text-color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            const text = swatch.getAttribute('data-text');
            pushUndoState();
            selectedElementIds.forEach(id => {
                const el = elements.find(item => item.id === id);
                if (el) {
                    el.textColor = text;
                    if (el.type === 'text' || el.type === 'draw') el.color = text;
                    if (el.type === 'line' || el.type === 'arrow') el.strokeColor = text;
                    const activeEditor = document.getElementById('boardInPlaceEditor');
                    if (activeEditor && editingElementId === el.id) {
                        activeEditor.style.setProperty('color', text, 'important');
                        activeEditor.style.setProperty('caret-color', text, 'important');
                    }
                }
            });
            document.getElementById('fmtColorPopover')?.classList.add('hidden');
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    });

    // Custom Fill / Sticky Color Picker (Formatting Popover)
    const fmtCustomBgPicker = document.getElementById('fmtCustomBgPicker');
    const fmtCustomBgDot = document.getElementById('fmtCustomBgDot');
    if (fmtCustomBgPicker) {
        fmtCustomBgPicker.addEventListener('input', (e) => {
            const bg = e.target.value;
            pushUndoState();
            selectedElementIds.forEach(id => {
                const el = elements.find(item => item.id === id);
                if (el) {
                    if (el.type === 'sticky') {
                        el.color = bg;
                    } else if (el.type === 'shape') {
                        el.fillColor = bg;
                    } else if (el.type === 'text') {
                        el.color = bg;
                        el.textColor = bg;
                        const activeEditor = document.getElementById('boardInPlaceEditor');
                        if (activeEditor && editingElementId === el.id) {
                            activeEditor.style.setProperty('color', bg, 'important');
                            activeEditor.style.setProperty('caret-color', bg, 'important');
                        }
                    } else if (el.type === 'draw') {
                        el.color = bg;
                    } else if (el.type === 'line' || el.type === 'arrow') {
                        el.strokeColor = bg;
                    }
                }
            });
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    }

    // Custom Shape / Line Border Color Picker (Formatting Popover)
    const fmtCustomBorderPicker = document.getElementById('fmtCustomBorderPicker');
    const fmtCustomBorderDot = document.getElementById('fmtCustomBorderDot');
    if (fmtCustomBorderPicker) {
        fmtCustomBorderPicker.addEventListener('input', (e) => {
            const border = e.target.value;
            pushUndoState();
            selectedElementIds.forEach(id => {
                const el = elements.find(item => item.id === id);
                if (el) {
                    if (el.type === 'draw') {
                        el.color = border;
                    } else if (el.type === 'line' || el.type === 'arrow') {
                        el.strokeColor = border;
                    } else {
                        el.strokeColor = border;
                        if (!el.strokeWidth || el.strokeWidth === 0) {
                            el.strokeWidth = 2;
                        }
                    }
                }
            });
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    }

    // Custom Text Color Picker (Formatting Popover)
    const fmtCustomTextPicker = document.getElementById('fmtCustomTextPicker');
    const fmtCustomTextDot = document.getElementById('fmtCustomTextDot');
    if (fmtCustomTextPicker) {
        fmtCustomTextPicker.addEventListener('input', (e) => {
            const text = e.target.value;
            pushUndoState();
            selectedElementIds.forEach(id => {
                const el = elements.find(item => item.id === id);
                if (el) {
                    el.textColor = text;
                    if (el.type === 'text' || el.type === 'draw') el.color = text;
                    if (el.type === 'line' || el.type === 'arrow') el.strokeColor = text;
                    const activeEditor = document.getElementById('boardInPlaceEditor');
                    if (activeEditor && editingElementId === el.id) {
                        activeEditor.style.setProperty('color', text, 'important');
                        activeEditor.style.setProperty('caret-color', text, 'important');
                    }
                }
            });
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    }

    // Duplicate, Layering, Delete
    document.getElementById('fmtDuplicate')?.addEventListener('click', () => window.duplicateSelectedElements());
    document.getElementById('fmtBringFront')?.addEventListener('click', () => window.bringSelectedToFront());
    document.getElementById('fmtSendBack')?.addEventListener('click', () => window.sendSelectedToBack());
    document.getElementById('fmtDelete')?.addEventListener('click', () => window.deleteSelectedElements());
}

function touchToMouseEvent(touch) {
    return {
        clientX: touch.clientX,
        clientY: touch.clientY,
        preventDefault: () => {}
    };
}

function updateSubPalettePosition(tool) {
    const activeBtn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
    if (!activeBtn) return;

    let palette = null;
    if (tool === 'sticky') palette = document.getElementById('stickySubPalette');
    else if (tool === 'shape') palette = document.getElementById('shapeSubPalette');
    else if (tool === 'pen' || tool === 'highlighter') palette = document.getElementById('penSubPalette');
    else if (tool === 'line' || tool === 'arrow') palette = document.getElementById('lineSubPalette');

    if (palette) {
        const dockEl = activeBtn.closest('.board-tools-dock');
        if (dockEl && window.innerWidth > 768) {
            const dockRect = dockEl.getBoundingClientRect();
            const btnRect = activeBtn.getBoundingClientRect();
            const offsetFromDockTop = btnRect.top - dockRect.top;
            let targetTop = dockEl.offsetTop + offsetFromDockTop;
            if (tool === 'shape') {
                targetTop = Math.max(76, targetTop - 36);
            } else {
                targetTop = Math.max(76, targetTop - 8);
            }
            palette.style.top = `${targetTop}px`;
        }
    }
}

const PEN_BASE_COLORS = [
    { color: '#1e293b', title: 'Charcoal' },
    { color: '#1e5eff', title: 'Blue' },
    { color: '#ef4444', title: 'Red' },
    { color: '#10b981', title: 'Green' },
    { color: '#8b5cf6', title: 'Purple' }
];

const HIGHLIGHTER_BASE_COLORS = [
    { color: '#facc15', title: 'Yellow' },
    { color: '#4ade80', title: 'Green' },
    { color: '#38bdf8', title: 'Sky Blue' },
    { color: '#f472b6', title: 'Pink' },
    { color: '#fb923c', title: 'Orange' }
];

function updateDrawingColorPalette(tool) {
    const container = document.getElementById('penColorsContainer');
    if (!container) return;
    const isHighlighter = (tool === 'highlighter');
    const colors = isHighlighter ? HIGHLIGHTER_BASE_COLORS : PEN_BASE_COLORS;
    const targetColor = (isHighlighter ? activeHighlighterColor : activePenColor).toLowerCase();

    const customWrapper = document.getElementById('penCustomColorWrapper');
    container.innerHTML = '';

    let matched = false;
    colors.forEach(item => {
        const dot = document.createElement('div');
        const isActive = item.color.toLowerCase() === targetColor;
        if (isActive) matched = true;
        dot.className = 'pen-color-dot' + (isActive ? ' active' : '');
        dot.setAttribute('data-color', item.color);
        dot.style.background = item.color;
        dot.title = item.title;
        dot.addEventListener('click', () => {
            if (activeTool === 'highlighter') {
                activeHighlighterColor = item.color;
            } else {
                activePenColor = item.color;
            }
            container.querySelectorAll('.pen-color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
        });
        container.appendChild(dot);
    });

    if (customWrapper) {
        container.appendChild(customWrapper);
        const customDot = document.getElementById('penCustomColorDot');
        if (customDot) {
            customDot.classList.toggle('active', !matched);
        }
    }
}

function showBoardToast(message, colorBadge) {
    let toast = document.getElementById('boardColorToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'boardColorToast';
        toast.style.position = 'fixed';
        toast.style.bottom = '24px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.background = 'rgba(15, 23, 42, 0.9)';
        toast.style.color = '#ffffff';
        toast.style.padding = '8px 16px';
        toast.style.borderRadius = '20px';
        toast.style.fontSize = '13px';
        toast.style.fontWeight = '600';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '8px';
        toast.style.zIndex = '99999';
        toast.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
        toast.style.transition = 'all 0.2s ease';
        document.body.appendChild(toast);
    }
    toast.innerHTML = colorBadge 
        ? `<span style="width: 14px; height: 14px; border-radius: 50%; background: ${colorBadge}; border: 1.5px solid #ffffff; display: inline-block;"></span> <span>${message}</span>`
        : `<span>${message}</span>`;
    toast.style.opacity = '1';
    toast.style.pointerEvents = 'auto';

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.pointerEvents = 'none';
    }, 2200);
}

function updatePickerLoupe(clientX, clientY) {
    let loupe = document.getElementById('boardPickerLoupe');
    if (!loupe) {
        loupe = document.createElement('div');
        loupe.id = 'boardPickerLoupe';
        loupe.style.position = 'fixed';
        loupe.style.pointerEvents = 'none';
        loupe.style.zIndex = '999999';
        loupe.style.width = '30px';
        loupe.style.height = '30px';
        loupe.style.borderRadius = '50%';
        loupe.style.border = '2.5px solid #ffffff';
        loupe.style.boxShadow = '0 2px 10px rgba(0,0,0,0.4)';
        loupe.style.transform = 'translate(-50%, -140%)';
        document.body.appendChild(loupe);
    }
    loupe.style.display = (activeTool === 'picker') ? 'block' : 'none';
    loupe.style.left = `${clientX}px`;
    loupe.style.top = `${clientY}px`;

    const canvas = document.getElementById('boardCanvas');
    if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const px = Math.floor((clientX - rect.left) * scaleX);
        const py = Math.floor((clientY - rect.top) * scaleY);
        try {
            const ctx = canvas.getContext('2d');
            const p = ctx.getImageData(px, py, 1, 1).data;
            if (p[3] > 0) {
                const hex = '#' + ((1 << 24) + (p[0] << 16) + (p[1] << 8) + p[2]).toString(16).slice(1);
                loupe.style.backgroundColor = hex;
            } else {
                loupe.style.backgroundColor = document.body.classList.contains('dark-theme') ? '#0b1437' : '#ffffff';
            }
        } catch (e) {}
    }
}

function pickColorAt(clientX, clientY) {
    const canvas = document.getElementById('boardCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = Math.floor((clientX - rect.left) * scaleX);
    const py = Math.floor((clientY - rect.top) * scaleY);

    const ctx = canvas.getContext('2d');
    let hex = '#1e5eff';
    try {
        const p = ctx.getImageData(px, py, 1, 1).data;
        if (p[3] === 0) {
            hex = document.body.classList.contains('dark-theme') ? '#0b1437' : '#ffffff';
        } else {
            hex = "#" + ((1 << 24) + (p[0] << 16) + (p[1] << 8) + p[2]).toString(16).slice(1);
        }
    } catch (err) {
        console.warn("Could not get pixel data from canvas:", err);
    }

    applyPickedColor(hex);
}

function applyPickedColor(hex) {
    activePenColor = hex;
    activeHighlighterColor = hex;
    activeLineColor = hex;

    // Update color pickers in UI
    const penCustom = document.getElementById('penCustomColorPicker');
    if (penCustom) penCustom.value = hex;
    const lineCustom = document.getElementById('lineCustomColorPicker');
    if (lineCustom) lineCustom.value = hex;
    const fmtBg = document.getElementById('fmtCustomBgPicker');
    if (fmtBg) fmtBg.value = hex;
    const fmtBorder = document.getElementById('fmtCustomBorderPicker');
    if (fmtBorder) fmtBorder.value = hex;
    const fmtText = document.getElementById('fmtCustomTextPicker');
    if (fmtText) fmtText.value = hex;

    // If elements are selected, apply color to them
    if (selectedElementIds.size > 0) {
        pushUndoState();
        elements.forEach(el => {
            if (selectedElementIds.has(el.id)) {
                if (el.type === 'shape' || el.type === 'sticky') {
                    el.color = hex;
                } else if (el.type === 'text') {
                    el.color = hex;
                    el.textColor = hex;
                } else if (el.type === 'line' || el.type === 'arrow' || el.type === 'draw') {
                    el.color = hex;
                    el.strokeColor = hex;
                }
            }
        });
        scheduleAutoSave();
        renderCanvas();
    }

    // Copy to clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(hex).catch(() => {});
    }

    showBoardToast(`Color copied: ${hex.toUpperCase()}`, hex);
    setWhiteboardTool('select');
}

function handleImageUpload(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        const dataUrl = evt.target.result;
        
        // Place in world coordinates at canvas center
        const cx = (window.innerWidth / 2 - camera.x) / camera.zoom;
        const cy = (window.innerHeight / 2 - camera.y) / camera.zoom;

        const imgEl = {
            id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            type: 'image',
            x: Math.round(cx - 150),
            y: Math.round(cy - 100),
            width: 300,
            height: 200,
            url: dataUrl,
            fileName: file.name || 'image.png',
            isUploading: true
        };

        const tempImg = new Image();
        tempImg.onload = () => {
            const aspect = tempImg.naturalWidth / tempImg.naturalHeight;
            const w = Math.min(400, Math.max(160, tempImg.naturalWidth));
            imgEl.width = Math.round(w);
            imgEl.height = Math.round(w / aspect);
            renderCanvas();
        };
        tempImg.src = dataUrl;

        pushUndoState();
        elements.push(imgEl);
        selectedElementIds.clear();
        selectedElementIds.add(imgEl.id);
        setWhiteboardTool('select');
        renderCanvas();
        scheduleAutoSave();

        showBoardToast("Uploading image to Google Drive (TimelineDB)...");
        uploadBoardImageToTimelineDB(file, dataUrl, imgEl);
    };
    reader.readAsDataURL(file);
}

async function uploadBoardImageToTimelineDB(file, dataUrl, imgEl) {
    const scriptUrl = localStorage.getItem('timelineDriveScriptUrl') || 
                      localStorage.getItem('googleDriveScriptUrl') || 
                      'https://script.google.com/macros/s/AKfycbzxuNo00ECJPS8ISWd8tepkMXGX5_EKnVBBujd1WtxZcsEp4tsJkfmJF3UEEgzahvTsiQ/exec';
    const folderId = localStorage.getItem('timelineDriveFolderId') || '';

    try {
        const base64Data = dataUrl.split(',')[1];
        const response = await fetch(scriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({
                fileName: file.name || 'board_img_' + Date.now() + '.png',
                mimeType: file.type || 'image/png',
                base64Data: base64Data,
                folderName: "TimelineDB",
                folderId: folderId,
                type: "board_image"
            })
        });

        const resText = await response.text();
        let resJson;
        try {
            resJson = JSON.parse(resText);
        } catch (pe) {
            console.warn("Raw Google Drive script response:", resText);
        }

        let finalUrl = '';
        if (resJson) {
            if (resJson.url || resJson.directUrl || resJson.viewUrl) {
                finalUrl = resJson.url || resJson.directUrl || resJson.viewUrl;
            } else if (resJson.fileId) {
                finalUrl = "https://lh3.googleusercontent.com/d/" + resJson.fileId;
            }
        }

        if (finalUrl) {
            imgEl.url = finalUrl;
            imgEl.isUploading = false;
            scheduleAutoSave();
            renderCanvas();
            showBoardToast("Image saved to Drive (TimelineDB)!");
        } else {
            imgEl.isUploading = false;
            renderCanvas();
        }
    } catch (err) {
        console.warn("Google Drive upload error for board image:", err);
        imgEl.isUploading = false;
        renderCanvas();
    }
}

function setWhiteboardTool(tool) {
    activeTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tool') === tool);
    });

    const surface = document.getElementById('boardCanvasSurface');
    if (surface) {
        surface.classList.toggle('mode-pan', tool === 'pan');
        surface.classList.toggle('mode-draw', tool === 'pen' || tool === 'highlighter');
        surface.classList.toggle('mode-crosshair', tool === 'line' || tool === 'arrow');
        surface.classList.toggle('mode-picker', tool === 'picker');
    }

    if (tool !== 'picker') {
        const loupe = document.getElementById('boardPickerLoupe');
        if (loupe) loupe.style.display = 'none';
    }

    // Toggle sub-palettes
    const stickyPalette = document.getElementById('stickySubPalette');
    if (stickyPalette) stickyPalette.classList.toggle('hidden', tool !== 'sticky');

    const shapePalette = document.getElementById('shapeSubPalette');
    if (shapePalette) shapePalette.classList.toggle('hidden', tool !== 'shape');

    const penPalette = document.getElementById('penSubPalette');
    if (penPalette) {
        const isDrawingTool = (tool === 'pen' || tool === 'highlighter');
        penPalette.classList.toggle('hidden', !isDrawingTool);
        if (isDrawingTool) {
            const penColorLabel = document.getElementById('penPaletteColorLabel');
            const penSizeLabel = document.getElementById('penPaletteSizeLabel');
            if (penColorLabel) penColorLabel.textContent = (tool === 'highlighter') ? 'HIGHLIGHTER COLOR' : 'PEN COLOR';
            if (penSizeLabel) penSizeLabel.textContent = (tool === 'highlighter') ? 'HIGHLIGHTER SIZE' : 'PEN SIZE';

            updateDrawingColorPalette(tool);

            const targetSize = (tool === 'highlighter') ? activeHighlighterSize : activePenSize;
            document.querySelectorAll('.pen-size-btn').forEach(b => {
                b.classList.toggle('active', parseFloat(b.getAttribute('data-size')) === targetSize);
            });
        }
    }

    const linePalette = document.getElementById('lineSubPalette');
    if (linePalette) {
        const isLineTool = (tool === 'line' || tool === 'arrow');
        linePalette.classList.toggle('hidden', !isLineTool);
    }

    // Reposition sub-palette to align with the clicked tool button
    updateSubPalettePosition(tool);

    if (tool !== 'select') {
        selectedElementIds.clear();
    }
    renderCanvas();
}

function onPointerDown(e) {
    if (editingElementId !== null) return; // Lock all element movement while editing text

    // 1. UNIVERSAL POPUP DISMISSAL
    // If any sub-palette or share modal is open when clicking on canvas,
    // close the popup first and do not trigger drawing/creating on this click!
    const openSubPalettes = [
        document.getElementById('stickySubPalette'),
        document.getElementById('shapeSubPalette'),
        document.getElementById('penSubPalette'),
        document.getElementById('lineSubPalette')
    ].filter(p => p && !p.classList.contains('hidden'));

    const shareModal = document.getElementById('boardShareModal');
    const isShareOpen = shareModal && !shareModal.classList.contains('hidden');

    if (openSubPalettes.length > 0 || isShareOpen) {
        openSubPalettes.forEach(p => p.classList.add('hidden'));
        if (isShareOpen) closeBoardShareModal();
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    // 2. RIGHT-CLICK DRAG TO PAN CANVAS
    // While holding right mouse button inside canvas, switch to hand tool and drag screen
    if (e.button === 2) {
        e.preventDefault();
        previousToolBeforeRightClick = activeTool;
        isRightClickPanning = true;
        isPanning = true;
        dragStart = { x: e.clientX, y: e.clientY };
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-tool') === 'pan');
        });
        const surf = document.getElementById('boardCanvasSurface');
        if (surf) surf.style.cursor = 'grabbing';
        return;
    }

    const pt = screenToWorld(e.clientX, e.clientY);
    dragStart = { x: e.clientX, y: e.clientY };

    if (currentBoard?.isReadOnly) {
        // Students can only drag to pan and inspect teacher boards!
        isPanning = true;
        const surf = document.getElementById('boardCanvasSurface');
        if (surf) surf.style.cursor = 'grabbing';
        return;
    }

    if (activeTool === 'picker') {
        pickColorAt(e.clientX, e.clientY);
        return;
    }

    if (activeTool === 'pan' || e.spaceKey) {
        isPanning = true;
        return;
    }

    if (activeTool === 'eraser') {
        isErasing = true;
        eraseAt(pt.x, pt.y);
        return;
    }

    if (activeTool === 'pen' || activeTool === 'highlighter') {
        isDrawing = true;
        currentDrawPoints = [{ x: pt.x, y: pt.y }];
        return;
    }

    if (activeTool === 'line' || activeTool === 'arrow') {
        const magnet = findNearestMagnetPoint(pt.x, pt.y, 28);
        isConnectingLine = true;
        startBinding = magnet ? { shapeId: magnet.shapeId, anchor: magnet.id } : null;
        endBinding = null;
        const startX = magnet ? magnet.x : pt.x;
        const startY = magnet ? magnet.y : pt.y;
        currentLineStart = { x: startX, y: startY };
        currentLineEnd = { x: startX, y: startY };
        hoveredMagnet = magnet;
        renderCanvas();
        return;
    }

    // Vertex / Corner / Line Endpoint Resize Handles (Single element selected)
    if (activeTool === 'select' && selectedElementIds.size === 1) {
        const hitHandle = findResizeHandleHit(pt.x, pt.y);
        if (hitHandle) {
            pushUndoState();
            isResizing = true;
            activeResizeHandle = hitHandle.handle;
            activeResizeElement = hitHandle.element;
            const ep = (hitHandle.element.type === 'line' || hitHandle.element.type === 'arrow') ? getLineEndpoints(hitHandle.element) : null;
            resizeStart = {
                ptX: pt.x,
                ptY: pt.y,
                x: hitHandle.element.x,
                y: hitHandle.element.y,
                width: hitHandle.element.width || 120,
                height: hitHandle.element.height || 80,
                ep: ep
            };
            return;
        }
    }

    if (activeTool === 'sticky') {
        pushUndoState();
        const newSticky = {
            id: `el-${Date.now()}`,
            type: 'sticky',
            x: pt.x - 90,
            y: pt.y - 80,
            width: 180,
            height: 160,
            text: 'Click or double click to type note...',
            color: activeStickyColor,
            textColor: '#713f12',
            rotation: (Math.random() * 4) - 2
        };
        elements.push(newSticky);
        selectedElementIds.clear();
        selectedElementIds.add(newSticky.id);
        setWhiteboardTool('select');
        scheduleAutoSave();
        renderCanvas();
        return;
    }

    if (activeTool === 'shape') {
        pushUndoState();
        const isSquare = activeShapeType === 'circle';
        const newShape = {
            id: `el-${Date.now()}`,
            type: 'shape',
            shapeType: activeShapeType,
            x: pt.x - 65,
            y: pt.y - (isSquare ? 55 : 40),
            width: isSquare ? 110 : 130,
            height: isSquare ? 110 : 80,
            fillColor: 'rgba(30, 94, 255, 0.1)',
            strokeColor: '#1e5eff',
            strokeWidth: 2,
            text: ''
        };
        elements.push(newShape);
        selectedElementIds.clear();
        selectedElementIds.add(newShape.id);
        setWhiteboardTool('select');
        scheduleAutoSave();
        renderCanvas();
        return;
    }

    if (activeTool === 'text') {
        pushUndoState();
        const newText = {
            id: `el-${Date.now()}`,
            type: 'text',
            x: pt.x,
            y: pt.y,
            width: 260,
            height: 40,
            text: 'Type text here...',
            fontSize: 20,
            fontFamily: "'Outfit', sans-serif",
            color: '#0f172a'
        };
        elements.push(newText);
        selectedElementIds.clear();
        selectedElementIds.add(newText.id);
        setWhiteboardTool('select');
        scheduleAutoSave();
        renderCanvas();
        openInPlaceTextEditor(newText);
        return;
    }

    // Select Tool: hit test
    const hitElement = findHitElement(pt.x, pt.y);
    if (hitElement) {
        if (!selectedElementIds.has(hitElement.id)) {
            if (!e.shiftKey) selectedElementIds.clear();
            selectedElementIds.add(hitElement.id);
        }
        isDragging = true;
        initialElementStates.clear();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                if (el.type === 'draw') {
                    initialElementStates.set(id, {
                        x: el.x || 0,
                        y: el.y || 0,
                        points: el.points ? el.points.map(p => ({ x: p.x, y: p.y })) : []
                    });
                } else if (el.type === 'line' || el.type === 'arrow') {
                    const ep = getLineEndpoints(el);
                    initialElementStates.set(id, {
                        x: el.x || 0,
                        y: el.y || 0,
                        x1: ep.x1,
                        y1: ep.y1,
                        x2: ep.x2,
                        y2: ep.y2
                    });
                } else {
                    initialElementStates.set(id, { x: el.x, y: el.y });
                }
            }
        });
    } else {
        if (!e.shiftKey) selectedElementIds.clear();
    }

    renderCanvas();
}

function onPointerMove(e) {
    if (editingElementId !== null) return; // Lock all element movement while editing text

    const pt = screenToWorld(e.clientX, e.clientY);

    if (activeTool === 'picker') {
        updatePickerLoupe(e.clientX, e.clientY);
        return;
    }

    if (isPanning) {
        camera.x += e.clientX - dragStart.x;
        camera.y += e.clientY - dragStart.y;
        dragStart = { x: e.clientX, y: e.clientY };
        renderCanvas();
        return;
    }

    if (activeTool === 'eraser' && isErasing) {
        eraseAt(pt.x, pt.y);
        return;
    }

    if (isDrawing) {
        currentDrawPoints.push({ x: pt.x, y: pt.y });
        renderCanvas();
        return;
    }

    if (isConnectingLine) {
        const magnet = findNearestMagnetPoint(pt.x, pt.y, 28);
        hoveredMagnet = magnet;
        endBinding = magnet ? { shapeId: magnet.shapeId, anchor: magnet.id } : null;
        currentLineEnd = magnet ? { x: magnet.x, y: magnet.y } : { x: pt.x, y: pt.y };
        renderCanvas();
        return;
    }

    // Magnet hover when line/arrow tool is active
    if (!isConnectingLine && (activeTool === 'line' || activeTool === 'arrow')) {
        const magnet = findNearestMagnetPoint(pt.x, pt.y, 28);
        if (magnet !== hoveredMagnet) {
            hoveredMagnet = magnet;
            renderCanvas();
        }
    }

    // Vertex / Corner / Line Endpoint Resizing
    if (isResizing && activeResizeElement) {
        const el = activeResizeElement;

        // Line / Arrow endpoint resizing with magnet snapping!
        if (el.type === 'line' || el.type === 'arrow') {
            const magnet = findNearestMagnetPoint(pt.x, pt.y, 28);
            hoveredMagnet = magnet;
            const targetX = magnet ? magnet.x : pt.x;
            const targetY = magnet ? magnet.y : pt.y;

            if (activeResizeHandle === 'start') {
                el.startBinding = magnet ? { shapeId: magnet.shapeId, anchor: magnet.id } : null;
                el.x1 = targetX;
                el.y1 = targetY;
            } else if (activeResizeHandle === 'end') {
                el.endBinding = magnet ? { shapeId: magnet.shapeId, anchor: magnet.id } : null;
                el.x2 = targetX;
                el.y2 = targetY;
            }
            el.x = Math.min(el.x1, el.x2);
            el.y = Math.min(el.y1, el.y2);
            el.width = Math.abs(el.x2 - el.x1);
            el.height = Math.abs(el.y2 - el.y1);
            renderCanvas();
            updateFormattingBar();
            return;
        }

        const dx = pt.x - resizeStart.ptX;
        const dy = pt.y - resizeStart.ptY;
        const origW = resizeStart.width || 120;
        const origH = resizeStart.height || 80;
        const aspect = (origH > 0) ? (origW / origH) : 1;

        if (e.shiftKey) {
            // Proportional resize preserving aspect ratio when Shift key is held
            if (activeResizeHandle === 'se') {
                let newW, newH;
                if (Math.abs(dx) >= Math.abs(dy * aspect)) {
                    newW = Math.max(30, Math.round(origW + dx));
                    newH = Math.max(30, Math.round(newW / aspect));
                } else {
                    newH = Math.max(30, Math.round(origH + dy));
                    newW = Math.max(30, Math.round(newH * aspect));
                }
                if (newW < 30) { newW = 30; newH = Math.max(30, Math.round(30 / aspect)); }
                if (newH < 30) { newH = 30; newW = Math.max(30, Math.round(30 * aspect)); }
                el.width = newW;
                el.height = newH;
            } else if (activeResizeHandle === 'sw') {
                let newW, newH;
                if (Math.abs(-dx) >= Math.abs(dy * aspect)) {
                    newW = Math.max(30, Math.round(origW - dx));
                    newH = Math.max(30, Math.round(newW / aspect));
                } else {
                    newH = Math.max(30, Math.round(origH + dy));
                    newW = Math.max(30, Math.round(newH * aspect));
                }
                if (newW < 30) { newW = 30; newH = Math.max(30, Math.round(30 / aspect)); }
                if (newH < 30) { newH = 30; newW = Math.max(30, Math.round(30 * aspect)); }
                el.x = Math.round(resizeStart.x + (origW - newW));
                el.width = newW;
                el.height = newH;
            } else if (activeResizeHandle === 'ne') {
                let newW, newH;
                if (Math.abs(dx) >= Math.abs(-dy * aspect)) {
                    newW = Math.max(30, Math.round(origW + dx));
                    newH = Math.max(30, Math.round(newW / aspect));
                } else {
                    newH = Math.max(30, Math.round(origH - dy));
                    newW = Math.max(30, Math.round(newH * aspect));
                }
                if (newW < 30) { newW = 30; newH = Math.max(30, Math.round(30 / aspect)); }
                if (newH < 30) { newH = 30; newW = Math.max(30, Math.round(30 * aspect)); }
                el.y = Math.round(resizeStart.y + (origH - newH));
                el.width = newW;
                el.height = newH;
            } else if (activeResizeHandle === 'nw') {
                let newW, newH;
                if (Math.abs(-dx) >= Math.abs(-dy * aspect)) {
                    newW = Math.max(30, Math.round(origW - dx));
                    newH = Math.max(30, Math.round(newW / aspect));
                } else {
                    newH = Math.max(30, Math.round(origH - dy));
                    newW = Math.max(30, Math.round(newH * aspect));
                }
                if (newW < 30) { newW = 30; newH = Math.max(30, Math.round(30 / aspect)); }
                if (newH < 30) { newH = 30; newW = Math.max(30, Math.round(30 * aspect)); }
                el.x = Math.round(resizeStart.x + (origW - newW));
                el.y = Math.round(resizeStart.y + (origH - newH));
                el.width = newW;
                el.height = newH;
            }
        } else {
            if (activeResizeHandle === 'se') {
                el.width = Math.max(30, Math.round(resizeStart.width + dx));
                el.height = Math.max(30, Math.round(resizeStart.height + dy));
            } else if (activeResizeHandle === 'sw') {
                const newW = Math.max(30, Math.round(resizeStart.width - dx));
                el.x = Math.round(resizeStart.x + (resizeStart.width - newW));
                el.width = newW;
                el.height = Math.max(30, Math.round(resizeStart.height + dy));
            } else if (activeResizeHandle === 'ne') {
                el.width = Math.max(30, Math.round(resizeStart.width + dx));
                const newH = Math.max(30, Math.round(resizeStart.height - dy));
                el.y = Math.round(resizeStart.y + (resizeStart.height - newH));
                el.height = newH;
            } else if (activeResizeHandle === 'nw') {
                const newW = Math.max(30, Math.round(resizeStart.width - dx));
                const newH = Math.max(30, Math.round(resizeStart.height - dy));
                el.x = Math.round(resizeStart.x + (resizeStart.width - newW));
                el.y = Math.round(resizeStart.y + (resizeStart.height - newH));
                el.width = newW;
                el.height = newH;
            }
        }
        renderCanvas();
        updateFormattingBar();
        return;
    }

    // Hover cursor for vertex handles
    if (!isDragging && activeTool === 'select') {
        const hitHandle = findResizeHandleHit(pt.x, pt.y);
        const surface = document.getElementById('boardCanvasSurface');
        if (surface) {
            if (hitHandle) {
                surface.style.cursor = hitHandle.cursor;
            } else if (!surface.classList.contains('mode-pan') && !surface.classList.contains('mode-draw')) {
                surface.style.cursor = 'default';
            }
        }
    }

    if (isDragging && selectedElementIds.size > 0) {
        const dx = (e.clientX - dragStart.x) / camera.zoom;
        const dy = (e.clientY - dragStart.y) / camera.zoom;

        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            const init = initialElementStates.get(id);
            if (el && init) {
                if (el.type === 'draw') {
                    el.x = init.x + dx;
                    el.y = init.y + dy;
                    if (init.points && init.points.length > 0) {
                        el.points = init.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
                    }
                } else if (el.type === 'line' || el.type === 'arrow') {
                    if (!el.startBinding) {
                        el.x1 = init.x1 + dx;
                        el.y1 = init.y1 + dy;
                    }
                    if (!el.endBinding) {
                        el.x2 = init.x2 + dx;
                        el.y2 = init.y2 + dy;
                    }
                    el.x = init.x + dx;
                    el.y = init.y + dy;
                } else {
                    el.x = init.x + dx;
                    el.y = init.y + dy;
                }
            }
        });
        renderCanvas();
    }
}

function onPointerUp(e) {
    if (isRightClickPanning) {
        isRightClickPanning = false;
        isPanning = false;
        setWhiteboardTool(previousToolBeforeRightClick || (currentBoard?.isReadOnly ? 'pan' : 'select'));
        const surf = document.getElementById('boardCanvasSurface');
        if (surf) surf.style.cursor = currentBoard?.isReadOnly ? 'grab' : '';
        renderCanvas();
        return;
    }

    if (currentBoard?.isReadOnly) {
        isPanning = false;
        const surf = document.getElementById('boardCanvasSurface');
        if (surf) surf.style.cursor = 'grab';
        return;
    }

    if (isPanning) isPanning = false;

    if (isErasing) {
        isErasing = false;
    }

    if (isConnectingLine) {
        isConnectingLine = false;
        hoveredMagnet = null;
        if (currentLineStart && currentLineEnd) {
            const dist = Math.hypot(currentLineEnd.x - currentLineStart.x, currentLineEnd.y - currentLineStart.y);
            if (dist >= 15 || startBinding || endBinding) {
                pushUndoState();
                const newLine = {
                    id: `el-${Date.now()}`,
                    type: activeTool === 'arrow' ? 'arrow' : 'line',
                    x: Math.min(currentLineStart.x, currentLineEnd.x),
                    y: Math.min(currentLineStart.y, currentLineEnd.y),
                    width: Math.max(20, Math.abs(currentLineEnd.x - currentLineStart.x)),
                    height: Math.max(20, Math.abs(currentLineEnd.y - currentLineStart.y)),
                    x1: currentLineStart.x,
                    y1: currentLineStart.y,
                    x2: currentLineEnd.x,
                    y2: currentLineEnd.y,
                    startBinding: startBinding,
                    endBinding: endBinding,
                    strokeColor: activeLineColor || '#1e5eff',
                    strokeWidth: activeLineWidth || 2.5
                };
                elements.push(newLine);
                selectedElementIds.clear();
                selectedElementIds.add(newLine.id);
                setWhiteboardTool('select');
                scheduleAutoSave();
            }
        }
        currentLineStart = null;
        currentLineEnd = null;
        startBinding = null;
        endBinding = null;
        renderCanvas();
        return;
    }

    if (isResizing) {
        isResizing = false;
        activeResizeHandle = null;
        activeResizeElement = null;
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
        return;
    }

    if (isDrawing && currentDrawPoints.length > 1) {
        pushUndoState();
        const bounds = computeStrokeBounds(currentDrawPoints);
        elements.push({
            id: `el-${Date.now()}`,
            type: 'draw',
            points: currentDrawPoints,
            x: bounds.minX,
            y: bounds.minY,
            width: bounds.width,
            height: bounds.height,
            color: activeTool === 'highlighter' ? activeHighlighterColor : activePenColor,
            size: activeTool === 'highlighter' ? activeHighlighterSize : activePenSize,
            isHighlighter: activeTool === 'highlighter'
        });
        isDrawing = false;
        currentDrawPoints = [];
        scheduleAutoSave();
        renderCanvas();
    }

    if (isDragging) {
        isDragging = false;
        scheduleAutoSave();
    }
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function isPointNearStroke(px, py, points, tolerance = 12) {
    if (!points || points.length === 0) return false;
    if (points.length === 1) return Math.hypot(px - points[0].x, py - points[0].y) <= tolerance;
    for (let i = 0; i < points.length - 1; i++) {
        if (distToSegment(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y) <= tolerance) {
            return true;
        }
    }
    return false;
}

function computeStrokeBounds(points) {
    if (!points || points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    });
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function eraseAt(wx, wy) {
    const hit = findHitElement(wx, wy);
    if (hit) {
        pushUndoState();
        elements = elements.filter(el => el.id !== hit.id);
        selectedElementIds.delete(hit.id);
        scheduleAutoSave();
        renderCanvas();
    }
}

function screenToWorld(sx, sy) {
    const surface = document.getElementById('boardCanvasSurface');
    const rect = surface ? surface.getBoundingClientRect() : { left: 0, top: 0 };
    return {
        x: (sx - rect.left - camera.x) / camera.zoom,
        y: (sy - rect.top - camera.y) / camera.zoom
    };
}

function findHitElement(wx, wy) {
    // Check in reverse order (top elements first)
    for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        if (el.type === 'draw') {
            const tol = Math.max(14, (el.size || 3) * 2.5);
            if (isPointNearStroke(wx, wy, el.points, tol)) {
                return el;
            }
            continue;
        }
        if (el.type === 'line' || el.type === 'arrow') {
            const ep = getLineEndpoints(el);
            const tol = Math.max(14, (el.strokeWidth || 2.5) * 2.5);
            if (distToSegment(wx, wy, ep.x1, ep.y1, ep.x2, ep.y2) <= tol) {
                return el;
            }
            continue;
        }
        const w = el.width || 100;
        const h = el.height || 60;
        if (wx >= el.x && wx <= el.x + w && wy >= el.y && wy <= el.y + h) {
            return el;
        }
    }
    return null;
}

function applyZoom(factor, centerX, centerY) {
    const surface = document.getElementById('boardCanvasSurface');
    const rect = surface ? surface.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    const cx = centerX !== undefined ? centerX - rect.left : rect.width / 2;
    const cy = centerY !== undefined ? centerY - rect.top : rect.height / 2;

    const newZoom = Math.max(0.2, Math.min(3, camera.zoom * factor));
    camera.x = cx - (cx - camera.x) * (newZoom / camera.zoom);
    camera.y = cy - (cy - camera.y) * (newZoom / camera.zoom);
    camera.zoom = newZoom;

    updateZoomDisplay();
    renderCanvas();
}

// --- 6. IN-PLACE TEXT EDITING & FORMATTING BAR ---
function openInPlaceTextEditor(el) {
    const surface = document.getElementById('boardCanvasSurface');
    if (!surface) return;

    // Immediately cancel any active dragging, resizing, or panning
    isDragging = false;
    isPanning = false;
    isDrawing = false;
    isResizing = false;
    activeResizeHandle = null;

    // Remove any previous in-place editor
    const existingEditor = document.getElementById('boardInPlaceEditor');
    if (existingEditor) existingEditor.remove();

    editingElementId = el.id;
    selectedElementIds.clear();
    selectedElementIds.add(el.id);
    renderCanvas(); // Hide the underlying canvas text immediately

    const isSticky = el.type === 'sticky';
    const isShape = el.type === 'shape';
    const isText = el.type === 'text';

    let screenX, screenY, screenW, screenH, fontSize, fontFamily, color, textAlign, isBold, isItalic;

    if (isSticky) {
        screenX = (el.x + 14) * camera.zoom + camera.x;
        screenY = (el.y + 16) * camera.zoom + camera.y;
        screenW = ((el.width || 180) - 28) * camera.zoom;
        screenH = ((el.height || 160) - 28) * camera.zoom;
        fontSize = (el.fontSize || 16) * camera.zoom;
        fontFamily = el.fontFamily || "'Caveat', cursive, sans-serif";
        color = el.textColor || '#713f12';
        textAlign = el.textAlign || 'left';
        isBold = !!el.isBold;
        isItalic = !!el.isItalic;
    } else if (isShape) {
        screenX = (el.x + 10) * camera.zoom + camera.x;
        screenY = (el.y + 10) * camera.zoom + camera.y;
        screenW = ((el.width || 120) - 20) * camera.zoom;
        screenH = ((el.height || 80) - 20) * camera.zoom;
        fontSize = (el.fontSize || 15) * camera.zoom;
        fontFamily = el.fontFamily || "'Inter', sans-serif";
        color = el.textColor || '#0f172a';
        textAlign = el.textAlign || 'center';
        isBold = !!el.isBold;
        isItalic = !!el.isItalic;
    } else { // text
        screenX = el.x * camera.zoom + camera.x;
        screenY = el.y * camera.zoom + camera.y;
        screenW = Math.max(160, (el.width || 260)) * camera.zoom;
        screenH = Math.max(40, (el.height || 60)) * camera.zoom;
        fontSize = (el.fontSize || 20) * camera.zoom;
        fontFamily = el.fontFamily || "'Outfit', sans-serif";
        color = el.color || el.textColor || '#0f172a';
        textAlign = el.textAlign || 'left';
        isBold = !!el.isBold;
        isItalic = !!el.isItalic;
    }

    // Ensure the font is actively loaded in the document
    ensureFontLoaded(fontFamily);

    const textarea = document.createElement('textarea');
    textarea.id = 'boardInPlaceEditor';
    textarea.value = el.text || '';

    // Apply strict inline styles with !important to defeat any external stylesheets
    textarea.style.setProperty('position', 'absolute', 'important');
    textarea.style.setProperty('left', `${screenX}px`, 'important');
    textarea.style.setProperty('top', `${screenY}px`, 'important');
    textarea.style.setProperty('width', `${screenW}px`, 'important');
    textarea.style.setProperty('height', `${screenH}px`, 'important');
    textarea.style.setProperty('font-size', `${fontSize}px`, 'important');
    textarea.style.setProperty('font-family', fontFamily, 'important');
    textarea.style.setProperty('font-weight', isBold ? '700' : '400', 'important');
    textarea.style.setProperty('font-style', isItalic ? 'italic' : 'normal', 'important');
    textarea.style.setProperty('text-align', textAlign, 'important');
    textarea.style.setProperty('line-height', '1.35', 'important');
    textarea.style.setProperty('color', color, 'important');
    textarea.style.setProperty('caret-color', color || '#1e5eff', 'important');
    textarea.style.setProperty('background', 'transparent', 'important');
    textarea.style.setProperty('border', 'none', 'important');
    textarea.style.setProperty('outline', 'none', 'important');
    textarea.style.setProperty('box-shadow', 'none', 'important');
    textarea.style.setProperty('resize', 'none', 'important');
    textarea.style.setProperty('margin', '0', 'important');
    textarea.style.setProperty('overflow', 'hidden', 'important');
    textarea.style.setProperty('z-index', '1000', 'important');
    textarea.style.setProperty('border-radius', '0', 'important');
    textarea.style.setProperty('white-space', 'pre-wrap', 'important');
    textarea.style.setProperty('word-break', 'break-word', 'important');
    textarea.style.setProperty('letter-spacing', 'normal', 'important');
    textarea.style.setProperty('box-sizing', 'border-box', 'important');

    // Perfect vertical centering alignment for shapes and sticky notes
    if (isShape) {
        const shapeLines = (el.text || '').split('\n').length || 1;
        const totalTextH = shapeLines * fontSize * 1.35;
        const topPad = Math.max(0, Math.round((screenH - totalTextH) / 2));
        textarea.style.setProperty('padding', `${topPad}px 0 0 0`, 'important');
    } else if (isSticky) {
        textarea.style.setProperty('padding', `${4 * camera.zoom}px 0 0 0`, 'important');
    } else {
        textarea.style.setProperty('padding', '0', 'important');
    }

    if (el.rotation) {
        textarea.style.setProperty('transform', `rotate(${el.rotation}deg)`, 'important');
        textarea.style.setProperty('transform-origin', `${(el.width / 2 - 14) * camera.zoom}px ${(el.height / 2 - 18) * camera.zoom}px`, 'important');
    }

    // Stop mouse and touch event propagation so highlighting/selecting text NEVER moves elements!
    ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'select', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup'].forEach(evtName => {
        textarea.addEventListener(evtName, (e) => {
            e.stopPropagation();
        });
    });

    surface.appendChild(textarea);
    textarea.focus();

    // Select all placeholder text if default
    if (textarea.value.startsWith('Click or double click') || textarea.value === 'Type text here...' || textarea.value.startsWith('Idea 1')) {
        textarea.select();
    } else {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    const adjustTextareaHeight = () => {
        if (isText) {
            textarea.style.setProperty('height', 'auto', 'important');
            const scrollH = textarea.scrollHeight;
            const targetH = Math.max(screenH, scrollH);
            textarea.style.setProperty('height', `${targetH}px`, 'important');
            el.height = Math.round(targetH / camera.zoom);
        } else if (isShape) {
            const shapeLines = (textarea.value || '').split('\n').length || 1;
            const totalTextH = shapeLines * fontSize * 1.35;
            const topPad = Math.max(0, Math.round((screenH - totalTextH) / 2));
            textarea.style.setProperty('padding', `${topPad}px 0 0 0`, 'important');
        }
    };

    let isCommitted = false;
    const commitText = () => {
        if (isCommitted) return;
        isCommitted = true;
        pushUndoState();
        el.text = textarea.value;
        editingElementId = null;
        isDragging = false;
        isResizing = false;
        textarea.remove();
        scheduleAutoSave();
        renderCanvas();
        updateFormattingBar();
    };

    textarea.addEventListener('input', () => {
        el.text = textarea.value;
        adjustTextareaHeight();
    });

    textarea.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement !== textarea && !document.getElementById('boardFormattingBar')?.contains(document.activeElement)) {
                commitText();
            }
        }, 120);
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            commitText();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commitText();
        }
        e.stopPropagation();
    });

    updateFormattingBar();
}

function updateFormattingBar() {
    const bar = document.getElementById('boardFormattingBar');
    if (!bar) return;

    if (selectedElementIds.size === 0) {
        bar.classList.add('hidden');
        document.getElementById('fmtColorPopover')?.classList.add('hidden');
        return;
    }

    if (!bar._hasMousedownPrevent) {
        bar._hasMousedownPrevent = true;
        bar.addEventListener('mousedown', (e) => {
            // Prevent clicking formatting buttons from stealing focus and closing inline editor
            if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
                e.preventDefault();
            }
        });
    }

    const selectedEl = elements.find(item => selectedElementIds.has(item.id));
    if (!selectedEl) {
        bar.classList.add('hidden');
        return;
    }

    bar.classList.remove('hidden');

    // Position formatting bar dynamically right above the selected element
    let boundsX = selectedEl.x || 0;
    let boundsY = selectedEl.y || 0;
    let boundsW = selectedEl.width || 120;
    if (selectedEl.type === 'line' || selectedEl.type === 'arrow') {
        const ep = getLineEndpoints(selectedEl);
        boundsX = Math.min(ep.x1, ep.x2);
        boundsY = Math.min(ep.y1, ep.y2);
        boundsW = Math.max(40, Math.abs(ep.x2 - ep.x1));
    } else if (selectedEl.type === 'draw') {
        const bounds = (selectedEl.width !== undefined && selectedEl.height !== undefined && selectedEl.x !== undefined && selectedEl.y !== undefined)
            ? { minX: selectedEl.x, minY: selectedEl.y, width: selectedEl.width, height: selectedEl.height }
            : computeStrokeBounds(selectedEl.points);
        boundsX = bounds.minX;
        boundsY = bounds.minY;
        boundsW = Math.max(40, bounds.width);
    }
    const screenX = (boundsX + boundsW / 2) * camera.zoom + camera.x;
    const screenY = boundsY * camera.zoom + camera.y;

    const clampedX = Math.max(180, Math.min(window.innerWidth - 340, screenX));
    const clampedY = Math.max(76, screenY - 50);

    bar.style.left = `${clampedX}px`;
    bar.style.top = `${clampedY}px`;
    bar.style.transform = 'translateX(-50%)';

    const isStrokeOnly = selectedEl.type === 'draw' || selectedEl.type === 'line' || selectedEl.type === 'arrow';
    const isShape = selectedEl.type === 'shape';

    // Show/hide font & text alignment controls
    const fontSelect = document.getElementById('fmtFontFamily');
    if (fontSelect) fontSelect.style.display = isStrokeOnly ? 'none' : '';
    const sizeDown = document.getElementById('fmtSizeDown');
    if (sizeDown && sizeDown.parentElement) sizeDown.parentElement.style.display = isStrokeOnly ? 'none' : '';
    const boldBtn = document.getElementById('fmtBold');
    if (boldBtn) boldBtn.style.display = isStrokeOnly ? 'none' : '';
    const italicBtn = document.getElementById('fmtItalic');
    if (italicBtn) italicBtn.style.display = isStrokeOnly ? 'none' : '';
    const alignLeft = document.getElementById('fmtAlignLeft');
    if (alignLeft && alignLeft.parentElement) alignLeft.parentElement.style.display = isStrokeOnly ? 'none' : '';

    // Sync Font Family
    if (fontSelect && selectedEl.fontFamily) {
        fontSelect.value = selectedEl.fontFamily;
    }

    // Sync Font Size
    const sizeVal = document.getElementById('fmtSizeVal');
    if (sizeVal) {
        sizeVal.innerText = `${selectedEl.fontSize || (selectedEl.type === 'sticky' ? 16 : (selectedEl.type === 'shape' ? 15 : 20))}px`;
    }

    // Sync Bold & Italic
    document.getElementById('fmtBold')?.classList.toggle('active', Boolean(selectedEl.isBold));
    document.getElementById('fmtItalic')?.classList.toggle('active', Boolean(selectedEl.isItalic));

    // Sync Text Alignment
    const align = selectedEl.textAlign || (selectedEl.type === 'shape' ? 'center' : 'left');
    document.getElementById('fmtAlignLeft')?.classList.toggle('active', align === 'left');
    document.getElementById('fmtAlignCenter')?.classList.toggle('active', align === 'center');
    document.getElementById('fmtAlignRight')?.classList.toggle('active', align === 'right');

    // Sync Shape / Line / Pen Stroke Thickness Group & Divider
    const isBorderElement = isShape || isStrokeOnly;
    const borderGroup = document.getElementById('fmtBorderGroup');
    const borderDivider = document.getElementById('fmtBorderDivider');
    if (borderGroup) borderGroup.classList.toggle('hidden', !isBorderElement);
    if (borderDivider) borderDivider.classList.toggle('hidden', !isBorderElement);

    const borderVal = document.getElementById('fmtBorderVal');
    if (borderVal) {
        if (selectedEl.type === 'draw') {
            borderVal.innerText = `${selectedEl.size || 4}px`;
        } else if (selectedEl.type === 'line' || selectedEl.type === 'arrow') {
            borderVal.innerText = `${selectedEl.strokeWidth !== undefined ? selectedEl.strokeWidth : 2.5}px`;
        } else {
            borderVal.innerText = `${selectedEl.strokeWidth !== undefined ? selectedEl.strokeWidth : 2}px`;
        }
    }

    // Sync Color Indicators (Fill & Border)
    const colorInd = document.getElementById('fmtColorIndicator');
    if (colorInd) {
        let fillColor = selectedEl.color || selectedEl.fillColor;
        if (selectedEl.type === 'line' || selectedEl.type === 'arrow') {
            fillColor = selectedEl.strokeColor;
        }
        colorInd.style.background = (fillColor && fillColor !== 'transparent') ? fillColor : '#f1f5f9';
    }

    const borderInd = document.getElementById('fmtBorderIndicator');
    if (borderInd) {
        borderInd.style.display = (isShape || selectedEl.type === 'line' || selectedEl.type === 'arrow') ? 'inline-block' : 'none';
        const borderColor = selectedEl.strokeColor;
        borderInd.style.borderColor = (borderColor && borderColor !== 'transparent') ? borderColor : '#cbd5e1';
    }
}

// --- 7. UNDO / REDO & AUTO-SAVE ---
function pushUndoState() {
    undoStack.push(JSON.stringify(elements));
    redoStack = [];
    if (undoStack.length > 30) undoStack.shift();
}

window.undo = function() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(elements));
    elements = JSON.parse(undoStack.pop());
    selectedElementIds.clear();
    scheduleAutoSave();
    renderCanvas();
};

window.redo = function() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(elements));
    elements = JSON.parse(redoStack.pop());
    selectedElementIds.clear();
    scheduleAutoSave();
    renderCanvas();
};

window.clearBoard = function() {
    if (currentBoard?.isReadOnly) {
        alert("Teacher lesson boards are view-only and cannot be cleared. Duplicate this board to make your own changes.");
        return;
    }
    if (!confirm("Clear all elements on this board?")) return;
    pushUndoState();
    elements = [];
    selectedElementIds.clear();
    scheduleAutoSave();
    renderCanvas();
};

function scheduleAutoSave() {
    if (currentBoard?.isReadOnly) return;
    hasUnsavedChanges = true;
    const syncStatus = document.getElementById('boardSyncStatus');
    if (syncStatus) syncStatus.innerText = '● Saving...';

    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        saveCurrentBoardDirectly();
    }, 600);
}

async function saveCurrentBoardDirectly() {
    if (!currentBoardId || !currentUser) return;
    if (currentBoard?.isReadOnly) return;
    const syncStatus = document.getElementById('boardSyncStatus');

    try {
        await updateDoc(doc(db, "boards", currentBoardId), {
            title: (currentBoard && currentBoard.title) || 'Untitled Board',
            elements: elements,
            settings: { gridStyle, zoom: camera.zoom, panX: camera.x, panY: camera.y },
            updatedAt: new Date().toISOString()
        });
        hasUnsavedChanges = false;
        if (syncStatus) syncStatus.innerText = '✓ Saved to cloud';
    } catch (err) {
        console.warn("Cloud auto-save error:", err);
        if (syncStatus) syncStatus.innerText = '⚠️ Save error';
    }
}

// --- 8. EXPORT TO PNG ---
window.exportBoardAsPNG = function() {
    const canvas = document.getElementById('whiteboardCanvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `${(currentBoard?.title || 'board').replace(/[^a-z0-9]/gi, '_')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
};

// --- 9. ELEMENT OPERATIONS (DELETE, DUPLICATE, LAYERING) ---
window.deleteSelectedElements = function() {
    if (selectedElementIds.size === 0) return;
    pushUndoState();
    elements = elements.filter(el => !selectedElementIds.has(el.id));
    selectedElementIds.clear();
    scheduleAutoSave();
    renderCanvas();
    updateFormattingBar();
};

window.duplicateSelectedElements = function() {
    if (selectedElementIds.size === 0) return;
    pushUndoState();
    const newSelected = new Set();
    selectedElementIds.forEach(id => {
        const el = elements.find(item => item.id === id);
        if (el) {
            const clone = JSON.parse(JSON.stringify(el));
            clone.id = `el-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            clone.x += 24;
            clone.y += 24;
            elements.push(clone);
            newSelected.add(clone.id);
        }
    });
    selectedElementIds = newSelected;
    scheduleAutoSave();
    renderCanvas();
    updateFormattingBar();
};

window.bringSelectedToFront = function() {
    if (selectedElementIds.size === 0) return;
    pushUndoState();
    const moving = elements.filter(el => selectedElementIds.has(el.id));
    const rest = elements.filter(el => !selectedElementIds.has(el.id));
    elements = [...rest, ...moving];
    scheduleAutoSave();
    renderCanvas();
};

window.sendSelectedToBack = function() {
    if (selectedElementIds.size === 0) return;
    pushUndoState();
    const moving = elements.filter(el => selectedElementIds.has(el.id));
    const rest = elements.filter(el => !selectedElementIds.has(el.id));
    elements = [...moving, ...rest];
    scheduleAutoSave();
    renderCanvas();
};

// --- 10. KEYBOARD SHORTCUTS ---
function setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        // Ignore if typing inside input / textarea
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

        if (currentBoard?.isReadOnly) {
            // Read-only mode: students cannot edit teacher boards with shortcuts
            if (e.key === 'Escape') {
                selectedElementIds.clear();
                renderCanvas();
            } else if (e.key.toLowerCase() === 'h') {
                setWhiteboardTool('pan');
            }
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) window.redo();
            else window.undo();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            window.redo();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            window.duplicateSelectedElements();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            document.getElementById('fmtBold')?.click();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
            e.preventDefault();
            document.getElementById('fmtItalic')?.click();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedElementIds.size > 0) {
                e.preventDefault();
                window.deleteSelectedElements();
            }
        } else if (e.key === 'Enter' && selectedElementIds.size === 1 && editingElementId === null) {
            const singleId = Array.from(selectedElementIds)[0];
            const el = elements.find(item => item.id === singleId);
            if (el && (el.type === 'text' || el.type === 'sticky' || el.type === 'shape')) {
                e.preventDefault();
                openInPlaceTextEditor(el);
                return;
            }
        } else if (e.key === 'Escape') {
            selectedElementIds.clear();
            renderCanvas();
        } else if (e.key.toLowerCase() === 'v') {
            setWhiteboardTool('select');
        } else if (e.key.toLowerCase() === 'h') {
            setWhiteboardTool('pan');
        } else if (e.key.toLowerCase() === 's') {
            setWhiteboardTool('sticky');
        } else if (e.key.toLowerCase() === 't') {
            setWhiteboardTool('text');
        } else if (e.key.toLowerCase() === 'p') {
            setWhiteboardTool('pen');
        } else if (e.key.toLowerCase() === 'e') {
            setWhiteboardTool('eraser');
        } else if (e.key.toLowerCase() === 'l') {
            setWhiteboardTool('line');
        } else if (e.key.toLowerCase() === 'a') {
            setWhiteboardTool('arrow');
        }
    });
}

// --- UTILITY DRAWING HELPERS ---
function roundRect(ctx, x, y, width, height, radius = 8, fill = true, stroke = false) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, center = false) {
    const lines = (text || '').split('\n');
    lines.forEach((lineText, lineIdx) => {
        const words = lineText.split(' ');
        let currentLine = '';

        for (let n = 0; n < words.length; n++) {
            const testLine = currentLine + words[n] + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && n > 0) {
                const drawX = center ? x + (maxWidth - ctx.measureText(currentLine).width) / 2 : x;
                ctx.fillText(currentLine, drawX, y);
                currentLine = words[n] + ' ';
                y += lineHeight;
            } else {
                currentLine = testLine;
            }
        }
        const drawX = center ? x + (maxWidth - ctx.measureText(currentLine).width) / 2 : x;
        ctx.fillText(currentLine, drawX, y);
        y += lineHeight;
    });
}

function drawStarPath(ctx, cx, cy, spikes = 5, outerRadius = 30, innerRadius = 15) {
    let rot = (Math.PI / 2) * 3;
    let x = cx;
    let y = cy;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
        x = cx + Math.cos(rot) * outerRadius;
        y = cy + Math.sin(rot) * outerRadius;
        ctx.lineTo(x, y);
        rot += step;

        x = cx + Math.cos(rot) * innerRadius;
        y = cy + Math.sin(rot) * innerRadius;
        ctx.lineTo(x, y);
        rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
}

function drawSpeechBubblePath(ctx, x, y, w, h) {
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + 40, y + h);
    ctx.lineTo(x + 20, y + h + 16);
    ctx.lineTo(x + 26, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawArrowHead(ctx, fromX, fromY, toX, toY, headLength = 10) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    ctx.restore();
}
