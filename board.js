// ==========================================================================
// BOARD.JS - Interactive Whiteboard & Digital Brainstorming Studio
// ==========================================================================

import { 
    collection, addDoc, getDocs, doc, deleteDoc, updateDoc, 
    query, where, getDoc, setDoc, onSnapshot, orderBy 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
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
let activeTool = 'select'; // 'select'|'pan'|'sticky'|'shape'|'text'|'pen'|'highlighter'|'line'|'arrow'|'eraser'
let activeShapeType = 'rectangle';
let activeStickyColor = '#fef08a'; // Yellow
let activePenColor = '#1e293b';
let activePenSize = 4;
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
    // 1. Check if student session is cached
    let studentCode = localStorage.getItem('loggedInStudentCode') || localStorage.getItem('studentCode') || '';
    let studentData = null;

    const rawSession = sessionStorage.getItem('studentLoggedInSession') || localStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession') || localStorage.getItem('studentTimelineSession');
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

            currentUser = {
                type: 'student',
                code: studentCode,
                name: (studentData && (studentData.name || studentData.studentName)) || 'Student',
                studentClass: (studentData && (studentData.studentClass || studentData.class)) || 'Unassigned',
                photoUrl: (studentData && studentData.photoUrl) || ''
            };
            updateNavUserUI();
            await loadBoards();
            return;
        } catch (err) {
            console.warn("Student profile load err:", err);
            currentUser = {
                type: 'student',
                code: studentCode,
                name: (studentData && (studentData.name || studentData.studentName)) || 'Student',
                studentClass: 'Unassigned',
                photoUrl: ''
            };
            updateNavUserUI();
            await loadBoards();
            return;
        }
    }

    // 2. Also listen to Firebase Auth for Teacher / Admin
    onAuthStateChanged(auth, async (firebaseUser) => {
        if (firebaseUser) {
            try {
                const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
                const userData = userDoc.exists() ? userDoc.data() : {};
                currentUser = {
                    type: 'staff',
                    uid: firebaseUser.uid,
                    name: userData.name || firebaseUser.displayName || 'Teacher',
                    role: userData.role || 'teacher',
                    subject: userData.subject || 'All',
                    studentClass: 'All',
                    photoUrl: userData.photoUrl || firebaseUser.photoURL || ''
                };
                updateNavUserUI();
                await loadBoards();
            } catch (e) {
                console.warn("Staff profile fetch err:", e);
            }
        }
    });

    // 3. Grace period before redirecting if not authenticated
    setTimeout(() => {
        if (!currentUser && !auth.currentUser) {
            window.location.href = 'index.html';
        }
    }, 1500);
}

function updateNavUserUI() {
    if (!currentUser) return;
    const isStaff = currentUser.type === 'staff';
    const nameEl = document.getElementById('hubUserName');
    if (nameEl) nameEl.innerText = currentUser.name;

    // Show/hide teacher-specific controls (e.g. sharing selector)
    document.querySelectorAll('.teacher-only-control').forEach(el => {
        el.classList.toggle('hidden', !isStaff);
    });
}

// --- 2. BOARD HUB MANAGEMENT ---
async function loadBoards() {
    if (!currentUser) return;
    const myGrid = document.getElementById('myBoardsGrid');
    const teacherGrid = document.getElementById('teacherBoardsGrid');
    const myCount = document.getElementById('myBoardsCount');
    const teacherCount = document.getElementById('teacherBoardsCount');

    try {
        // Fetch My Boards from Firestore
        let myQuery;
        if (currentUser.type === 'staff') {
            myQuery = query(collection(db, "boards"), where("authorUid", "==", currentUser.uid));
        } else {
            myQuery = query(collection(db, "boards"), where("authorCode", "==", currentUser.code));
        }

        const mySnap = await getDocs(myQuery);
        myBoardsList = [];
        mySnap.forEach(docSnap => myBoardsList.push({ id: docSnap.id, ...docSnap.data() }));

        // Fetch Teacher Shared Boards from Firestore
        const teacherQuery = query(collection(db, "boards"), where("isShared", "==", true));
        const teacherSnap = await getDocs(teacherQuery);
        teacherBoardsList = [];
        teacherSnap.forEach(docSnap => {
            const data = docSnap.data();
            const target = (data.targetClass || 'All').trim();
            const studentClass = (currentUser.studentClass || '').trim();
            if (currentUser.type === 'staff' || target === 'All' || target.toLowerCase() === studentClass.toLowerCase()) {
                teacherBoardsList.push({ id: docSnap.id, ...data });
            }
        });

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
    if (!myGrid || !teacherGrid) return;

    if (activeTab === 'my-boards') {
        myGrid.classList.remove('hidden');
        teacherGrid.classList.add('hidden');

        if (myBoardsList.length === 0) {
            myGrid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 48px 20px; text-align: center; color: var(--text-gray);">
                    <div style="font-size: 36px; margin-bottom: 8px;">🎨</div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: var(--text-dark);">No Boards Created Yet</h3>
                    <p style="margin: 4px 0 16px 0; font-size: 13px;">Create your first personal board or pick a template above to get started!</p>
                    <button class="board-create-btn" onclick="window.createNewBoard('Blank Board')">+ New Blank Board</button>
                </div>
            `;
            return;
        }

        myGrid.innerHTML = myBoardsList.map(b => `
            <div class="board-item-card" onclick="window.openBoardEditor('${b.id}')">
                <div class="board-thumb-area">
                    <div style="font-size: 32px; opacity: 0.7;">📋</div>
                </div>
                <div class="board-card-body">
                    <div class="board-card-title-row">
                        <h4 class="board-card-title">${escapeHtml(b.title || 'Untitled Board')}</h4>
                        ${b.isShared ? `<span class="board-badge-shared">Shared (${escapeHtml(b.targetClass || 'All')})</span>` : ''}
                    </div>
                    <div class="board-card-meta">
                        <span>${formatDate(b.updatedAt || b.createdAt)}</span>
                        <div style="display: flex; gap: 4px;" onclick="event.stopPropagation();">
                            <button class="board-icon-btn" style="width: 28px; height: 28px; font-size: 11px;" title="Duplicate" onclick="window.duplicateBoard('${b.id}')">📑</button>
                            <button class="board-icon-btn" style="width: 28px; height: 28px; font-size: 11px; color: #ef4444;" title="Delete" onclick="window.deleteBoard('${b.id}')">🗑️</button>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } else {
        teacherGrid.classList.remove('hidden');
        myGrid.classList.add('hidden');

        if (teacherBoardsList.length === 0) {
            teacherGrid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 48px 20px; text-align: center; color: var(--text-gray);">
                    <div style="font-size: 36px; margin-bottom: 8px;">🎓</div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: var(--text-dark);">No Shared Teacher Boards</h3>
                    <p style="margin: 4px 0 0 0; font-size: 13px;">When teachers publish lesson boards for your class, they will appear here.</p>
                </div>
            `;
            return;
        }

        teacherGrid.innerHTML = teacherBoardsList.map(b => `
            <div class="board-item-card" onclick="window.openBoardEditor('${b.id}', true)">
                <div class="board-thumb-area" style="background: rgba(30, 94, 255, 0.06);">
                    <div style="font-size: 32px; opacity: 0.8;">👨‍🏫</div>
                </div>
                <div class="board-card-body">
                    <div class="board-card-title-row">
                        <h4 class="board-card-title">${escapeHtml(b.title || 'Teacher Board')}</h4>
                        <span class="board-badge-shared">Teacher Board</span>
                    </div>
                    <div class="board-card-meta">
                        <span>By ${escapeHtml(b.authorName || 'Teacher')}</span>
                        <button class="board-create-btn" style="padding: 4px 10px; font-size: 11px;" onclick="event.stopPropagation(); window.copyTeacherBoardToMine('${b.id}')">
                            Duplicate & Edit
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
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

    // Student Logout
    const handleLogout = () => {
        if (confirm("Are you sure you want to log out?")) {
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
        renderHubBoardsGrid();
    });

    document.getElementById('tabTeacherBoards')?.addEventListener('click', () => {
        activeTab = 'teacher-boards';
        document.getElementById('tabTeacherBoards')?.classList.add('active');
        document.getElementById('tabMyBoards')?.classList.remove('active');
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
                { id: `el-${timestamp}-1`, type: 'text', x: 200, y: 80, width: 400, height: 50, text: '💡 Brainstorming Session', fontSize: 28, fontFamily: 'Outfit, sans-serif', color: '#1e293b', isBold: true },
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
    try {
        const snap = await getDoc(doc(db, "boards", boardId));
        if (snap.exists()) {
            currentBoardId = boardId;
            currentBoard = { id: snap.id, ...snap.data(), isReadOnly: isReadOnly };
            openBoardWorkspace(currentBoard);
        } else {
            alert("Board not found.");
        }
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
    if (!currentUser) return;
    try {
        const snap = await getDoc(doc(db, "boards", boardId));
        if (snap.exists()) {
            const data = snap.data();
            const myCopy = {
                ...data,
                title: `My Copy - ${data.title}`,
                authorUid: currentUser.uid || '',
                authorCode: currentUser.code || '',
                authorName: currentUser.name || 'Student',
                authorRole: 'student',
                studentClass: currentUser.studentClass || 'Unassigned',
                isShared: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            const newDoc = await addDoc(collection(db, "boards"), myCopy);
            alert("Board copied to your personal workspace!");
            window.openBoardEditor(newDoc.id);
        }
    } catch (err) {
        alert("Copy error: " + err.message);
    }
};

window.deleteBoard = async function(boardId) {
    if (!confirm("Are you sure you want to delete this board?")) return;
    try {
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

    const titleInput = document.getElementById('boardTitleInput');
    if (titleInput) titleInput.value = boardData.title || 'Untitled Board';

    const shareBtn = document.getElementById('btnShareBoardToggle');
    if (shareBtn && currentUser?.type === 'staff') {
        shareBtn.classList.toggle('active', Boolean(boardData.isShared));
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
    if (hasUnsavedChanges) {
        saveCurrentBoardDirectly();
    }
    document.getElementById('boardWorkspaceView')?.classList.add('hidden');
    document.getElementById('boardHubView')?.classList.remove('hidden');
    loadBoards();
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
        renderStrokePoints(ctx, currentDrawPoints, activePenColor, activePenSize, activeTool === 'highlighter');
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
        if (el.type !== 'shape' && el.type !== 'sticky') continue;
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
        if (el.type !== 'shape' && el.type !== 'sticky') return;
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
            const tool = btn.getAttribute('data-tool');
            setWhiteboardTool(tool);
        });
    });

    // Top bar actions
    document.getElementById('btnBoardBack')?.addEventListener('click', window.closeBoardWorkspace);
    document.getElementById('btnUndo')?.addEventListener('click', window.undo);
    document.getElementById('btnRedo')?.addEventListener('click', window.redo);
    document.getElementById('btnClearBoard')?.addEventListener('click', window.clearBoard);
    document.getElementById('btnSaveBoard')?.addEventListener('click', () => {
        saveCurrentBoardDirectly();
    });
    document.getElementById('btnExportPng')?.addEventListener('click', window.exportBoardAsPNG);

    document.getElementById('boardTitleInput')?.addEventListener('change', (e) => {
        if (currentBoard) {
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
            activeStickyColor = dot.getAttribute('data-color');
            document.querySelectorAll('.sticky-color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
        });
    });

    // Shape Choices in Shape Sub-palette
    document.querySelectorAll('.shape-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeShapeType = btn.getAttribute('data-shape') || 'rectangle';
            document.querySelectorAll('.shape-choice-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setWhiteboardTool('shape');
        });
    });

    // Pen Colors in Pen Sub-palette
    document.querySelectorAll('.pen-color-dot').forEach(dot => {
        dot.addEventListener('click', () => {
            activePenColor = dot.getAttribute('data-color') || '#1e293b';
            document.querySelectorAll('.pen-color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
        });
    });

    // Pen Sizes in Pen Sub-palette
    document.querySelectorAll('.pen-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activePenSize = parseFloat(btn.getAttribute('data-size')) || 4;
            document.querySelectorAll('.pen-size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // Connector Style in Line Sub-palette (Straight vs Arrow)
    document.querySelectorAll('.line-style-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.getAttribute('data-type') || 'line';
            setWhiteboardTool(type);
            document.querySelectorAll('.line-style-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // Line Colors in Line Sub-palette
    document.querySelectorAll('.line-color-dot').forEach(dot => {
        dot.addEventListener('click', () => {
            activeLineColor = dot.getAttribute('data-color') || '#1e5eff';
            document.querySelectorAll('.line-color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
        });
    });

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
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtSizeDown')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.fontSize = Math.max(10, (el.fontSize || 16) - 2);
            }
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtSizeUp')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) {
                el.fontSize = Math.min(72, (el.fontSize || 16) + 2);
            }
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtBold')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) el.isBold = !el.isBold;
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtItalic')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) el.isItalic = !el.isItalic;
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtAlignLeft')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) el.textAlign = 'left';
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtAlignCenter')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) el.textAlign = 'center';
        });
        scheduleAutoSave();
        renderCanvas();
    });

    document.getElementById('fmtAlignRight')?.addEventListener('click', () => {
        pushUndoState();
        selectedElementIds.forEach(id => {
            const el = elements.find(item => item.id === id);
            if (el) el.textAlign = 'right';
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
                }
            });
            document.getElementById('fmtColorPopover')?.classList.add('hidden');
            scheduleAutoSave();
            renderCanvas();
            updateFormattingBar();
        });
    });

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
    }

    // Toggle sub-palettes
    const stickyPalette = document.getElementById('stickySubPalette');
    if (stickyPalette) stickyPalette.classList.toggle('hidden', tool !== 'sticky');

    const shapePalette = document.getElementById('shapeSubPalette');
    if (shapePalette) shapePalette.classList.toggle('hidden', tool !== 'shape');

    const penPalette = document.getElementById('penSubPalette');
    if (penPalette) penPalette.classList.toggle('hidden', tool !== 'pen' && tool !== 'highlighter');

    const linePalette = document.getElementById('lineSubPalette');
    if (linePalette) linePalette.classList.toggle('hidden', tool !== 'line' && tool !== 'arrow');

    if (tool !== 'select') {
        selectedElementIds.clear();
    }
    renderCanvas();
}

function onPointerDown(e) {
    if (editingElementId !== null) return; // Lock all element movement while editing text

    const pt = screenToWorld(e.clientX, e.clientY);
    dragStart = { x: e.clientX, y: e.clientY };

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
            color: activePenColor,
            size: activePenSize,
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
        screenY = (el.y + 18) * camera.zoom + camera.y;
        screenW = ((el.width || 180) - 28) * camera.zoom;
        screenH = ((el.height || 160) - 28) * camera.zoom;
        fontSize = (el.fontSize || 16) * camera.zoom;
        fontFamily = el.fontFamily || "'Caveat', cursive, sans-serif";
        color = el.textColor || '#713f12';
        textAlign = el.textAlign || 'left';
        isBold = el.isBold || false;
        isItalic = el.isItalic || false;
    } else if (isShape) {
        screenX = (el.x + 10) * camera.zoom + camera.x;
        screenY = (el.y + 10) * camera.zoom + camera.y;
        screenW = ((el.width || 120) - 20) * camera.zoom;
        screenH = ((el.height || 80) - 20) * camera.zoom;
        fontSize = (el.fontSize || 15) * camera.zoom;
        fontFamily = el.fontFamily || "'Inter', sans-serif";
        color = el.textColor || '#0f172a';
        textAlign = el.textAlign || 'center';
        isBold = el.isBold || false;
        isItalic = el.isItalic || false;
    } else { // text
        screenX = el.x * camera.zoom + camera.x;
        screenY = el.y * camera.zoom + camera.y;
        screenW = Math.max(160, (el.width || 260)) * camera.zoom;
        screenH = (el.height || 60) * camera.zoom;
        fontSize = (el.fontSize || 20) * camera.zoom;
        fontFamily = el.fontFamily || "'Outfit', sans-serif";
        color = el.textColor || el.color || '#0f172a';
        textAlign = el.textAlign || 'left';
        isBold = el.isBold || false;
        isItalic = el.isItalic || false;
    }

    const textarea = document.createElement('textarea');
    textarea.id = 'boardInPlaceEditor';
    textarea.value = el.text || '';
    textarea.style.left = `${screenX}px`;
    textarea.style.top = `${screenY}px`;
    textarea.style.width = `${screenW}px`;
    textarea.style.height = `${screenH}px`;
    textarea.style.fontSize = `${fontSize}px`;
    textarea.style.fontFamily = fontFamily;
    textarea.style.fontWeight = isBold ? '700' : '400';
    textarea.style.fontStyle = isItalic ? 'italic' : 'normal';
    textarea.style.textAlign = textAlign;
    textarea.style.lineHeight = '1.35';
    textarea.style.color = color;

    if (el.rotation) {
        textarea.style.transform = `rotate(${el.rotation}deg)`;
        textarea.style.transformOrigin = `${(el.width / 2 - 14) * camera.zoom}px ${(el.height / 2 - 18) * camera.zoom}px`;
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
    if (textarea.value.startsWith('Click or double click') || textarea.value === 'Type text here...') {
        textarea.select();
    } else {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

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
    });

    textarea.addEventListener('blur', commitText);
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
}

function updateFormattingBar() {
    const bar = document.getElementById('boardFormattingBar');
    if (!bar) return;

    if (selectedElementIds.size === 0 || editingElementId !== null) {
        bar.classList.add('hidden');
        document.getElementById('fmtColorPopover')?.classList.add('hidden');
        return;
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
    if (!confirm("Clear all elements on this board?")) return;
    pushUndoState();
    elements = [];
    selectedElementIds.clear();
    scheduleAutoSave();
    renderCanvas();
};

function scheduleAutoSave() {
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
