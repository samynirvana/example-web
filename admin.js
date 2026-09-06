import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile, updateEmail, updatePassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, addDoc, getDocs, doc, deleteDoc, updateDoc, query, where, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { app, db, auth, secondaryAuth } from "./firebase.js";
import { escapeHtml, formatDate } from "./utils.js";
import * as GClassSync from "./classroomSync.js";

// --- UTILITY: DEBOUNCE FUNCTION ---
// Prevents functions from firing repeatedly on every single keystroke
function debounce(func, delay = 200) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func(...args), delay);
    };
}

let userRole = null;
let teacherSubject = null;
let currentTeacherProfileData = null;
let pendingTeacherPhotoFile = null;
let teacherPhotoRemoved = false;

// --- DYNAMIC AUTH & PERMISSION LISTENER (FAST & PARALLEL) ---
onAuthStateChanged(auth, async (user) => {
    const loginScreen = document.getElementById('loginScreen');
    const adminDashboard = document.getElementById('adminDashboard');
    const subjectInput = document.getElementById('subject');
    const tableTitle = document.getElementById('tableTitle');
    const welcomeTitle = document.getElementById('welcomeTitle');

    if (user) {
        try {
            // 1. Fetch User Role & Subject FIRST so queries know what permissions to apply
            const userDoc = await getDoc(doc(db, "users", user.uid));
            let userData = null;
            if (userDoc.exists()) {
                userData = userDoc.data();
                userRole = userData.role;
                teacherSubject = userData.subject || "";
            } else {
                userRole = "teacher";
                teacherSubject = "Unassigned";
            }

            // 2. Format Display Name & Update Sidebar UI
            const rawEmail = user.email || "user@mks.sch.id";
            const formattedName = rawEmail.split('@')[0]
                .replace(/[._]/g, ' ')
                .replace(/\b\w/g, char => char.toUpperCase());

            const displayName = (userData && userData.name) || user.displayName || formattedName;
            const photoUrl = (userData && userData.photoUrl) || user.photoURL || null;

            currentTeacherProfileData = {
                uid: user.uid,
                email: user.email || rawEmail,
                name: displayName,
                role: userRole,
                subject: teacherSubject,
                photoUrl: photoUrl
            };

            const sidebarNameEl = document.getElementById('sidebarUserName');
            const sidebarRoleEl = document.getElementById('sidebarUserRole');
            const avatarCircleEl = document.getElementById('userAvatarCircle');

            const mobileSidebarNameEl = document.getElementById('mobileSidebarUserName');
            const mobileSidebarRoleEl = document.getElementById('mobileSidebarUserRole');
            const mobileAvatarCircleEl = document.getElementById('mobileUserAvatarCircle');

            const roleDisplayName = userRole === "admin" ? "Super Admin" : `Teacher (${teacherSubject})`;

            if (sidebarNameEl) sidebarNameEl.innerText = displayName;
            if (sidebarRoleEl) sidebarRoleEl.innerText = roleDisplayName;

            const renderAvatar = (el) => {
                if (!el) return;
                const initial = (displayName || 'U').charAt(0).toUpperCase();
                if (photoUrl) {
                    el.innerHTML = `<img src="${photoUrl}" alt="${displayName}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" onerror="this.onerror=null; this.parentElement.innerText='${initial}';">`;
                } else {
                    el.innerText = initial;
                }
            };

            renderAvatar(avatarCircleEl);

            if (mobileSidebarNameEl) mobileSidebarNameEl.innerText = displayName;
            if (mobileSidebarRoleEl) mobileSidebarRoleEl.innerText = roleDisplayName;
            renderAvatar(mobileAvatarCircleEl);

            const welcomeTitleEl = document.getElementById('welcomeTitle') || document.querySelector('.greeting-title');
            const welcomeSubEl = document.getElementById('welcomeSub') || document.querySelector('.greeting-subtitle');

            const getGreetingPrefix = () => {
                const hour = new Date().getHours();
                if (hour >= 12 && hour < 17) return "Good afternoon";
                if (hour >= 17 || hour < 5) return "Good evening";
                return "Good morning";
            };

            const firstName = displayName ? displayName.split(' ')[0] : (formattedName ? formattedName.split(' ')[0] : (userRole === "admin" ? "Admin" : "Teacher"));

            if (welcomeTitleEl) {
                welcomeTitleEl.innerText = `${getGreetingPrefix()}, ${firstName} 👋`;
            }

            if (welcomeSubEl) {
                if (userRole === "admin") {
                    welcomeSubEl.innerText = "Here’s what’s happening today across school administration.";
                } else {
                    welcomeSubEl.innerText = `Here’s what’s happening today in your ${teacherSubject || 'Class'} department.`;
                }
            }

            loginScreen.classList.add('hidden');
            adminDashboard.classList.remove('hidden');

            // 3. Set UI Views and Role Permissions
            if (userRole === "admin") {
                document.querySelectorAll('.admin-only-view').forEach(el => el.classList.remove('hidden'));

                if (subjectInput) {
                    subjectInput.disabled = false;
                    subjectInput.value = "";
                    subjectInput.placeholder = "Subject Name (e.g. English)";
                }
                if (tableTitle) tableTitle.innerText = "Master Registry Ledger - All Subjects & Classes";

            } else {
                document.querySelectorAll('.admin-only-view').forEach(el => el.classList.add('hidden'));

                if (subjectInput) {
                    subjectInput.value = teacherSubject;
                    subjectInput.disabled = true;
                }
                if (tableTitle) tableTitle.innerText = `Departmental Performance Ledger: ${teacherSubject}`;

                const directSubSelect = document.getElementById('directSubjectSelect');
                if (directSubSelect && teacherSubject) {
                    directSubSelect.value = teacherSubject;
                }
            }

            window.loadAdminDriveSettings();

            // 4. Build array of tasks to fetch concurrently in PARALLEL
            const parallelTasks = [
                loadNewsTable(),
                loadAdminTable(),
                loadPointsTable(),
                loadStudentsDirectory(),
                updateDashboardStats(),
                loadQuizzesTable(),
                syncScoresToExamScores(),
                initAttendanceTab()
            ];

            if (typeof window.loadSystemDatabases === "function") {
                parallelTasks.push(window.loadSystemDatabases());
            }

            if (userRole === "admin") {
                parallelTasks.push(loadTeachersDirectory());
            }

            // Execute all queries simultaneously
            await Promise.all(parallelTasks);

        } catch (err) {
            console.error("Error querying identity permissions: ", err);
            alert("Error setting up session: " + err.message);
        }
    } else {
        loginScreen.classList.remove('hidden');
        adminDashboard.classList.add('hidden');
    }
});

async function loginAdmin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        alert("Authentication Failed: " + error.message);
    }
}

async function logoutAdmin() {
    await signOut(auth);
}

async function createTeacherAccount() {
    const name = document.getElementById('newTeacherName').value.trim();
    const email = document.getElementById('newTeacherEmail').value.trim();
    const password = document.getElementById('newTeacherPassword').value.trim();
    const subject = document.getElementById('newTeacherSubject').value.trim();

    if (!name || !email || !password || !subject) {
        alert("All fields (Name, Email, Password, Subject) are required to register a teacher.");
        return;
    }

    try {
        const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        await setDoc(doc(db, "users", credential.user.uid), {
            name: name,
            email: email,
            role: "teacher",
            subject: subject
        });
        alert(`Teacher Registered Successfully!\nName: ${name}\nEmail: ${email}\nSubject: ${subject}`);

        document.getElementById('newTeacherName').value = "";
        document.getElementById('newTeacherEmail').value = "";
        document.getElementById('newTeacherPassword').value = "";
        document.getElementById('newTeacherSubject').value = "";

        await secondaryAuth.signOut();
        loadTeachersDirectory();
        if (typeof window.loadSystemDatabases === "function") {
            window.loadSystemDatabases();
        }
    } catch (e) {
        alert("Registration operation rejected: " + e.message);
    }
}

window.generateNewUniqueCode = async function (oldCode) {
    if (confirm(`Are you sure you want to generate a new unique code for student ${oldCode}? The old code will be retired.`)) {
        try {
            const studentRef = doc(db, "students", oldCode);
            const studentSnap = await getDoc(studentRef);

            if (!studentSnap.exists()) {
                alert("Student record missing.");
                return;
            }

            const studentData = studentSnap.data();
            const newCode = await generateUniqueStudentCode();

            // Create new record with new code ID
            await setDoc(doc(db, "students", newCode), studentData);

            // Delete old record
            await deleteDoc(studentRef);

            alert(`Code updated successfully!\nOld Code: ${oldCode}\nNew Code: ${newCode}`);

            loadStudentsDirectory();
            renderDbStudentsTable();
            loadPointsTable();
        } catch (e) {
            alert("Error regenerating student code: " + e.message);
        }
    }
};

// --- STUDENT REGISTRATION MODE SWITCHER ---
window.setStudentRegMode = function (mode) {
    const singleForm = document.getElementById('studentRegSingleForm');
    const bulkForm = document.getElementById('studentRegBulkForm');
    const photosForm = document.getElementById('studentRegPhotosForm');
    const btnSingle = document.getElementById('btnModeSingle');
    const btnBulk = document.getElementById('btnModeBulk');
    const btnPhotos = document.getElementById('btnModePhotos');

    if (singleForm) singleForm.classList.toggle('hidden', mode !== 'single');
    if (bulkForm) bulkForm.classList.toggle('hidden', mode !== 'bulk');
    if (photosForm) photosForm.classList.toggle('hidden', mode !== 'photos');

    if (btnSingle) btnSingle.classList.toggle('active', mode === 'single');
    if (btnBulk) btnBulk.classList.toggle('active', mode === 'bulk');
    if (btnPhotos) btnPhotos.classList.toggle('active', mode === 'photos');
};

// --- SCORE INPUT MODE SWITCHER & DROPDOWN ---
window.toggleScoreModeDropdown = function (e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('scoreModeDropdownMenu');
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.score-mode-menu, .score-ledger-dropdown').forEach(d => d.classList.add('hidden'));
    document.getElementById('scoreModeDropdownTrigger')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnScoreLedgerMenuToggle')?.setAttribute('aria-expanded', 'false');
    if (isHidden) {
        menu.classList.remove('hidden');
        document.getElementById('scoreModeDropdownTrigger')?.setAttribute('aria-expanded', 'true');
    }
};

window.closeScoreModeDropdown = function () {
    const menu = document.getElementById('scoreModeDropdownMenu');
    if (menu) menu.classList.add('hidden');
    document.getElementById('scoreModeDropdownTrigger')?.setAttribute('aria-expanded', 'false');
};

// Split button controller for View Score Ledger & Download Excel
window.toggleScoreLedgerDropdown = function (e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('scoreLedgerDropdownMenu');
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.score-mode-menu, .score-ledger-dropdown').forEach(d => d.classList.add('hidden'));
    document.getElementById('scoreModeDropdownTrigger')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnScoreLedgerMenuToggle')?.setAttribute('aria-expanded', 'false');
    if (isHidden) {
        menu.classList.remove('hidden');
        document.getElementById('btnScoreLedgerMenuToggle')?.setAttribute('aria-expanded', 'true');
    }
};

window.closeScoreLedgerDropdown = function () {
    const menu = document.getElementById('scoreLedgerDropdownMenu');
    if (menu) menu.classList.add('hidden');
    document.getElementById('btnScoreLedgerMenuToggle')?.setAttribute('aria-expanded', 'false');
};

window.setScoreInputMode = function (mode) {
    const singleView = document.getElementById('scoreInputSingleView');
    const bulkView = document.getElementById('scoreInputBulkView');
    const gclassView = document.getElementById('scoreInputGClassView');
    const btnSingle = document.getElementById('btnScoreInputSingle');
    const btnBulk = document.getElementById('btnScoreInputBulk');
    const btnGclass = document.getElementById('btnScoreInputGClass');
    const titleEl = document.getElementById('scoreInputHeaderTitle');
    const labelEl = document.getElementById('scoreModeActiveLabel');
    const iconEl = document.getElementById('scoreModeActiveIcon');

    // Remove active class from all options
    document.querySelectorAll('.score-mode-option').forEach(opt => opt.classList.remove('active'));

    if (mode === 'bulk') {
        if (singleView) singleView.classList.add('hidden');
        if (gclassView) gclassView.classList.add('hidden');
        if (bulkView) bulkView.classList.remove('hidden');
        if (btnSingle) btnSingle.classList.remove('active');
        if (btnGclass) btnGclass.classList.remove('active');
        if (btnBulk) btnBulk.classList.add('active');
        if (titleEl) titleEl.innerText = 'Multiple Input Score';
        if (labelEl) labelEl.innerText = 'Multiple Input Score';
        if (iconEl) iconEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`;
    } else if (mode === 'gclass') {
        if (singleView) singleView.classList.add('hidden');
        if (bulkView) bulkView.classList.add('hidden');
        if (gclassView) gclassView.classList.remove('hidden');
        if (btnSingle) btnSingle.classList.remove('active');
        if (btnBulk) btnBulk.classList.remove('active');
        if (btnGclass) btnGclass.classList.add('active');
        if (titleEl) titleEl.innerText = 'Sync Google Classroom';
        if (labelEl) labelEl.innerText = 'Sync Google Classroom';
        if (iconEl) iconEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"></path><path d="M6 12v5c3 3 9 3 12 0v-5"></path></svg>`;
        initGoogleClassroomSyncUI();
    } else {
        if (bulkView) bulkView.classList.add('hidden');
        if (gclassView) gclassView.classList.add('hidden');
        if (singleView) singleView.classList.remove('hidden');
        if (btnBulk) btnBulk.classList.remove('active');
        if (btnGclass) btnGclass.classList.remove('active');
        if (btnSingle) btnSingle.classList.add('active');
        if (titleEl) titleEl.innerText = 'Input scores';
        if (labelEl) labelEl.innerText = 'Input scores';
        if (iconEl) iconEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
    }
    closeScoreModeDropdown();
};

// --- GOOGLE CLASSROOM SYNC CONTROLLER ---
let gclassCoursesList = [];
let gclassCurrentCourseWorks = [];
let gclassPreviewItems = [];
let gclassFirestoreStudents = [];

function initGoogleClassroomSyncUI() {
    const btnConnect = document.getElementById('btnConnectGoogleClassroom');
    const btnSettingsToggle = document.getElementById('btnGclassSettingsToggle');
    const settingsPanel = document.getElementById('gclassSettingsPanel');
    const clientIdInput = document.getElementById('gclassClientIdInput');
    const btnSaveClientId = document.getElementById('btnSaveGclassClientId');
    const courseSelect = document.getElementById('gclassCourseSelect');
    const btnFetchWork = document.getElementById('btnFetchCourseWork');
    const btnSelectAll = document.getElementById('btnSelectAllGclassWork');
    const btnDeselectAll = document.getElementById('btnDeselectAllGclassWork');
    const btnPreview = document.getElementById('btnPreviewGclassSync');
    const btnCommit = document.getElementById('btnCommitGclassSync');
    const previewSelectAll = document.getElementById('gclassPreviewSelectAll');
    const previewSearchInput = document.getElementById('gclassPreviewSearchInput');

    if (clientIdInput) {
        clientIdInput.value = GClassSync.getGoogleClientId();
        // Auto-fetch from Firestore database if not yet cached on this browser
        GClassSync.fetchGoogleClientIdFromFirestore().then(dbClientId => {
            if (dbClientId && clientIdInput) {
                clientIdInput.value = dbClientId;
            }
        });
    }

    if (btnSettingsToggle && settingsPanel) {
        btnSettingsToggle.onclick = () => {
            settingsPanel.classList.toggle('hidden');
        };
    }

    if (btnSaveClientId && clientIdInput) {
        btnSaveClientId.onclick = async () => {
            const val = clientIdInput.value.trim();
            btnSaveClientId.disabled = true;
            btnSaveClientId.innerText = "Saving...";
            try {
                await GClassSync.setGoogleClientId(val);
                alert("Google OAuth Client ID saved successfully to database!");
                settingsPanel.classList.add('hidden');
            } catch (err) {
                alert("Error saving Client ID: " + err.message);
            } finally {
                btnSaveClientId.disabled = false;
                btnSaveClientId.innerText = "Save Client ID";
            }
        };
    }

    if (btnConnect) {
        btnConnect.onclick = async () => {
            let currentClientId = GClassSync.getGoogleClientId();
            if (!currentClientId) {
                currentClientId = await GClassSync.fetchGoogleClientIdFromFirestore();
            }
            if (!currentClientId) {
                if (settingsPanel) settingsPanel.classList.remove('hidden');
                if (clientIdInput) clientIdInput.focus();
                alert("Please configure your Google Cloud OAuth Client ID first.");
                return;
            }

            btnConnect.disabled = true;
            btnConnect.innerText = "Connecting...";
            try {
                await GClassSync.authenticateGoogleClassroom();
                
                const statusText = document.getElementById('gclassStatusText');
                if (statusText) statusText.innerHTML = `<span style="color: #10b981; font-weight: 700;">● Connected</span> - Ready to sync classroom assignments & scores`;
                btnConnect.style.background = "#10b981";
                btnConnect.innerText = "Connected ✓";

                // Load courses
                await loadGoogleClassroomCourses();
            } catch (err) {
                console.error("Google Classroom Connection Error:", err);
                alert("Connection failed: " + err.message);
                btnConnect.innerText = "Connect Classroom";
            } finally {
                btnConnect.disabled = false;
            }
        };
    }

    if (courseSelect) {
        courseSelect.onchange = () => {
            const selectedCourseId = courseSelect.value;
            const courseObj = gclassCoursesList.find(c => c.id === selectedCourseId);
            if (!courseObj) return;

            const { detectedSubject, detectedClass } = GClassSync.detectSubjectAndClass(courseObj.name, courseObj.section);
            
            const subjectSelect = document.getElementById('gclassTargetSubject');
            const classSelect = document.getElementById('gclassTargetClass');

            if (subjectSelect) {
                if (detectedSubject) {
                    subjectSelect.value = detectedSubject;
                } else if (teacherSubject && teacherSubject !== "All Subjects" && teacherSubject !== "Unassigned") {
                    subjectSelect.value = teacherSubject;
                }
            }

            if (classSelect) {
                if (detectedClass) {
                    classSelect.value = detectedClass;
                } else {
                    classSelect.value = "Grade 9A";
                }
            }

            // Hide previous coursework and preview sections when course changes
            const workSection = document.getElementById('gclassWorkSection');
            const previewSection = document.getElementById('gclassPreviewSection');
            if (workSection) workSection.classList.add('hidden');
            if (previewSection) previewSection.classList.add('hidden');
        };
    }

    if (btnFetchWork) {
        btnFetchWork.onclick = async () => {
            const courseSelect = document.getElementById('gclassCourseSelect');
            const courseId = courseSelect?.value;
            if (!courseId) {
                alert("Please select a Google Classroom course first.");
                return;
            }

            btnFetchWork.disabled = true;
            btnFetchWork.innerHTML = `<span class="spinner-small" style="display: inline-block; width: 14px; height: 14px; border: 2px solid white; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span> Loading...`;
            
            try {
                const workSection = document.getElementById('gclassWorkSection');
                const workListContainer = document.getElementById('gclassWorkListContainer');
                const previewSection = document.getElementById('gclassPreviewSection');
                if (previewSection) previewSection.classList.add('hidden');

                gclassCurrentCourseWorks = await GClassSync.fetchCourseWork(courseId);

                if (!gclassCurrentCourseWorks.length) {
                    workListContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-gray);">No published assignments found in this class.</div>`;
                } else {
                    workListContainer.innerHTML = gclassCurrentCourseWorks.map((cw, idx) => {
                        const dueDateStr = cw.dueDate ? `${cw.dueDate.year}-${String(cw.dueDate.month).padStart(2,'0')}-${String(cw.dueDate.day).padStart(2,'0')}` : 'No due date';
                        const maxPts = cw.maxPoints !== undefined ? `${cw.maxPoints} pts` : 'Ungraded / 100 pts';
                        return `
                            <label style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #ffffff; border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.borderColor='var(--primary-blue)'" onmouseout="this.style.borderColor='var(--border-color)'">
                                <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
                                    <input type="checkbox" class="gclass-work-checkbox" data-work-id="${escapeHtml(cw.id)}" value="${escapeHtml(cw.id)}" ${idx === 0 ? 'checked' : ''} style="width: 17px; height: 17px; cursor: pointer;">
                                    <div>
                                        <div style="font-weight: 600; font-size: 13.5px; color: var(--text-dark);">${escapeHtml(cw.title || 'Untitled Assignment')}</div>
                                        <div style="font-size: 12px; color: var(--text-gray); margin-top: 2px;">Due: ${escapeHtml(dueDateStr)} • Max: ${escapeHtml(maxPts)}</div>
                                    </div>
                                </div>
                                <span style="font-size: 11px; background: #f1f5f9; color: #475569; font-weight: 700; padding: 3px 8px; border-radius: 12px;">Classwork</span>
                            </label>
                        `;
                    }).join('');
                }

                if (workSection) workSection.classList.remove('hidden');
            } catch (err) {
                alert("Failed to load classwork: " + err.message);
            } finally {
                btnFetchWork.disabled = false;
                btnFetchWork.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Load Classwork`;
            }
        };
    }

    if (btnSelectAll) {
        btnSelectAll.onclick = () => {
            document.querySelectorAll('.gclass-work-checkbox').forEach(cb => cb.checked = true);
        };
    }

    if (btnDeselectAll) {
        btnDeselectAll.onclick = () => {
            document.querySelectorAll('.gclass-work-checkbox').forEach(cb => cb.checked = false);
        };
    }

    if (btnPreview) {
        btnPreview.onclick = async () => {
            const courseSelect = document.getElementById('gclassCourseSelect');
            const subjectSelect = document.getElementById('gclassTargetSubject');
            const classSelect = document.getElementById('gclassTargetClass');

            const courseId = courseSelect?.value;
            const targetSubject = subjectSelect?.value || 'English';
            const targetClass = classSelect?.value || 'Grade 9A';

            const selectedWorkIds = Array.from(document.querySelectorAll('.gclass-work-checkbox:checked')).map(cb => cb.value);
            if (!selectedWorkIds.length) {
                alert("Please select at least one classwork assignment to sync.");
                return;
            }

            const selectedCourseWorks = gclassCurrentCourseWorks.filter(cw => selectedWorkIds.includes(cw.id));

            btnPreview.disabled = true;
            btnPreview.innerHTML = `Calculating student matches...`;

            try {
                const previewSection = document.getElementById('gclassPreviewSection');
                const result = await GClassSync.buildSyncPreview({
                    courseId,
                    selectedCourseWorks,
                    targetSubject,
                    targetClass
                });

                gclassPreviewItems = result.previewList;
                gclassFirestoreStudents = result.allFirestoreStudents;

                renderGclassPreviewTable();
                if (previewSection) previewSection.classList.remove('hidden');
            } catch (err) {
                console.error("Preview Error:", err);
                alert("Failed to build preview: " + err.message);
            } finally {
                btnPreview.disabled = false;
                btnPreview.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg> Preview Email Matches & Scores`;
            }
        };
    }

    if (previewSelectAll) {
        previewSelectAll.onchange = () => {
            const isChecked = previewSelectAll.checked;
            gclassPreviewItems.forEach(item => {
                if (item.classroomGrade !== null && item.studentCode) {
                    item.selected = isChecked;
                }
            });
            renderGclassPreviewTable();
        };
    }

    if (previewSearchInput) {
        previewSearchInput.oninput = debounce(() => {
            renderGclassPreviewTable();
        }, 150);
    }

    if (btnCommit) {
        btnCommit.onclick = async () => {
            const itemsToSync = gclassPreviewItems.filter(item => item.selected && item.classroomGrade !== null && item.studentCode);
            if (!itemsToSync.length) {
                alert("No items selected for sync. Please ensure students are matched and grades are entered.");
                return;
            }

            if (!confirm(`Are you ready to sync ${itemsToSync.length} score(s) to the database?`)) {
                return;
            }

            btnCommit.disabled = true;
            btnCommit.innerHTML = `Writing to database...`;

            try {
                const result = await GClassSync.commitSyncToFirestore(itemsToSync);
                alert(`🎉 Successfully synchronized ${result.totalSynced} score(s)!\n• ${result.insertedCount} new scores added\n• ${result.updatedCount} scores updated`);
                
                // Refresh admin table and views
                loadAdminTable();
                
                // Re-run preview to show updated status
                if (btnPreview) btnPreview.click();
            } catch (err) {
                alert("Sync failed: " + err.message);
            } finally {
                btnCommit.disabled = false;
                btnCommit.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Confirm & Sync Scores to Database`;
            }
        };
    }
}

async function loadGoogleClassroomCourses() {
    const courseSection = document.getElementById('gclassCourseSelectionSection');
    const courseSelect = document.getElementById('gclassCourseSelect');
    const subjectSelect = document.getElementById('gclassTargetSubject');
    const classSelect = document.getElementById('gclassTargetClass');

    if (!courseSelect) return;

    courseSelect.innerHTML = `<option value="">Loading your courses...</option>`;

    try {
        gclassCoursesList = await GClassSync.fetchCourses();
        if (!gclassCoursesList.length) {
            courseSelect.innerHTML = `<option value="">No active courses found</option>`;
            return;
        }

        courseSelect.innerHTML = `<option value="">-- Choose a Course (${gclassCoursesList.length} available) --</option>` +
            gclassCoursesList.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || 'Untitled')}${c.section ? ` (${escapeHtml(c.section)})` : ''}</option>`).join('');

        // Populate Subjects
        const standardSubjects = ["English", "ICT", "Science", "Math", "Bahasa Indonesia", "Art", "Music", "Civics", "Social Studies", "Physical Education", "General Assessment"];
        if (subjectSelect) {
            subjectSelect.innerHTML = standardSubjects.map(s => `<option value="${s}">${s}</option>`).join('');
        }

        // Populate Classes
        const standardClasses = ["Grade 9A", "Grade 9B", "Grade 9C", "Grade 7A", "Grade 7B", "Grade 8A", "Grade 8B", "Grade 10A", "Grade 10B", "Grade 11A", "Grade 12"];
        if (classSelect) {
            classSelect.innerHTML = standardClasses.map(cl => `<option value="${cl}">${cl}</option>`).join('');
        }

        // Auto-select Grade 9A course if present (e.g. English G9A or ICT G9A)
        const g9aCourse = gclassCoursesList.find(c => (c.name || '').toLowerCase().includes('9a') || (c.section || '').toLowerCase().includes('9a'));
        if (g9aCourse) {
            courseSelect.value = g9aCourse.id;
            courseSelect.dispatchEvent(new Event('change'));
        }

        if (courseSection) courseSection.classList.remove('hidden');
    } catch (err) {
        console.error("Error loading courses:", err);
        courseSelect.innerHTML = `<option value="">Failed to load courses</option>`;
        alert("Error loading Google Classroom courses: " + err.message);
    }
}

function renderGclassPreviewTable() {
    const tbody = document.getElementById('gclassPreviewTableBody');
    const summaryPills = document.getElementById('gclassSyncSummaryPills');
    const statsText = document.getElementById('gclassPreviewStatsText');
    const searchFilter = document.getElementById('gclassPreviewSearchInput')?.value.toLowerCase().trim() || '';

    if (!tbody) return;

    let totalReady = 0;
    let totalUpdated = 0;
    let totalIdentical = 0;
    let totalNoGrade = 0;
    let totalUnmatched = 0;

    gclassPreviewItems.forEach(item => {
        if (item.syncStatus === 'READY_NEW') totalReady++;
        else if (item.syncStatus === 'READY_UPDATE') totalUpdated++;
        else if (item.syncStatus === 'IDENTICAL') totalIdentical++;
        else if (item.syncStatus === 'NO_GRADE') totalNoGrade++;
        else if (item.syncStatus === 'UNMATCHED_EMAIL') totalUnmatched++;
    });

    if (summaryPills) {
        summaryPills.innerHTML = `
            <span style="background: #ecfdf5; color: #065f46; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 20px;">✨ ${totalReady} New</span>
            <span style="background: #eff6ff; color: #1e40af; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 20px;">🔄 ${totalUpdated} Updates</span>
            <span style="background: #f1f5f9; color: #475569; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px;">✓ ${totalIdentical} Up to Date</span>
            ${totalUnmatched > 0 ? `<span style="background: #fef2f2; color: #991b1b; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 20px;">⚠️ ${totalUnmatched} Unmatched</span>` : ''}
            ${totalNoGrade > 0 ? `<span style="background: #fffbeb; color: #92400e; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px;">⏳ ${totalNoGrade} Unscored</span>` : ''}
        `;
    }

    if (statsText) {
        statsText.innerText = `Displaying ${gclassPreviewItems.length} submission(s) across selected classwork.`;
    }

    const filteredItems = gclassPreviewItems.filter(item => {
        if (!searchFilter) return true;
        return (
            (item.classroomStudentName || '').toLowerCase().includes(searchFilter) ||
            (item.classroomEmail || '').toLowerCase().includes(searchFilter) ||
            (item.studentCode || '').toLowerCase().includes(searchFilter) ||
            (item.courseWorkTitle || '').toLowerCase().includes(searchFilter)
        );
    });

    if (!filteredItems.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-gray);">No submissions found matching criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredItems.map((item, idx) => {
        const itemGlobalIndex = gclassPreviewItems.indexOf(item);
        
        let statusBadge = '';
        if (item.syncStatus === 'READY_NEW') {
            statusBadge = `<span style="background: #ecfdf5; color: #10b981; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">+ New Score</span>`;
        } else if (item.syncStatus === 'READY_UPDATE') {
            statusBadge = `<span style="background: #eff6ff; color: #3b82f6; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Update (${item.existingScoreVal} → ${item.classroomGrade})</span>`;
        } else if (item.syncStatus === 'IDENTICAL') {
            statusBadge = `<span style="background: #f1f5f9; color: #64748b; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">Up to Date</span>`;
        } else if (item.syncStatus === 'NO_GRADE') {
            statusBadge = `<span style="background: #fffbeb; color: #d97706; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">No Grade in Classroom</span>`;
        } else if (item.syncStatus === 'UNMATCHED_EMAIL') {
            statusBadge = `<span style="background: #fef2f2; color: #ef4444; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Email Unmatched</span>`;
        }

        const isCheckable = item.classroomGrade !== null && item.studentCode;

        // Student code cell with fallback dropdown if unmatched
        let studentCodeHtml = '';
        if (item.matchedStudent) {
            studentCodeHtml = `<span style="font-family: monospace; font-weight: 700; color: var(--primary-blue);">${escapeHtml(item.studentCode)}</span> <small style="color: var(--text-gray);">(${escapeHtml(item.targetClass)})</small>`;
        } else {
            // Dropdown to manually link student
            const options = gclassFirestoreStudents.map(st => `<option value="${escapeHtml(st.id)}">${escapeHtml(st.studentName)} (${escapeHtml(st.id)} - ${escapeHtml(st.studentClass)})</option>`).join('');
            studentCodeHtml = `
                <select style="font-size: 12px; padding: 4px 6px; border: 1px solid #f87171; border-radius: 6px; background: #fff5f5;" onchange="window.manualLinkGclassStudent(${itemGlobalIndex}, this.value)">
                    <option value="">-- Link Student --</option>
                    ${options}
                </select>
            `;
        }

        const scoreDisplay = item.classroomGrade !== null 
            ? `<strong style="font-size: 14px; color: var(--text-dark);">${item.classroomGrade}</strong> <span style="color: var(--text-gray); font-size: 12px;">/ ${item.courseWorkMaxPoints}</span>`
            : `<span style="color: var(--text-gray); font-style: italic;">Not Graded</span>`;

        return `
            <tr style="border-bottom: 1px solid var(--border-color); ${!item.selected ? 'opacity: 0.65;' : ''}">
                <td style="text-align: center;">
                    <input type="checkbox" ${item.selected ? 'checked' : ''} ${!isCheckable ? 'disabled' : ''} onchange="window.toggleGclassPreviewItem(${itemGlobalIndex}, this.checked)" style="width: 16px; height: 16px; cursor: pointer;">
                </td>
                <td>
                    <div style="font-weight: 600; color: var(--text-dark); font-size: 13.5px;">${escapeHtml(item.classroomStudentName)}</div>
                </td>
                <td>
                    <div style="font-size: 12.5px; color: #475569; font-family: monospace;">${escapeHtml(item.classroomEmail || 'No email')}</div>
                </td>
                <td>${studentCodeHtml}</td>
                <td>
                    <div style="font-size: 13px; font-weight: 600; color: var(--text-dark);">${escapeHtml(item.courseWorkTitle)}</div>
                </td>
                <td style="text-align: center;">${scoreDisplay}</td>
                <td style="text-align: center;">${statusBadge}</td>
            </tr>
        `;
    }).join('');
}

window.toggleGclassPreviewItem = function(globalIndex, isChecked) {
    if (gclassPreviewItems[globalIndex]) {
        gclassPreviewItems[globalIndex].selected = isChecked;
        renderGclassPreviewTable();
    }
};

window.manualLinkGclassStudent = function(globalIndex, selectedStudentCode) {
    const item = gclassPreviewItems[globalIndex];
    if (!item) return;

    const matched = gclassFirestoreStudents.find(st => st.id === selectedStudentCode);
    if (matched) {
        item.matchedStudent = matched;
        item.studentCode = matched.id;
        item.studentName = matched.studentName;
        item.targetClass = matched.studentClass;
        item.syncStatus = item.classroomGrade !== null ? 'READY_NEW' : 'NO_GRADE';
        item.selected = item.classroomGrade !== null;
        renderGclassPreviewTable();
    }
};

// --- VIEW STUDENT CODE MODAL ---
window.viewStudentCode = function (studentId, studentName, studentClass) {
    const modal = document.getElementById('studentCodeModal');
    const nameEl = document.getElementById('modalStudentCodeName');
    const classEl = document.getElementById('modalStudentCodeClass');
    const codeEl = document.getElementById('modalDisplayStudentCode');
    const copyBtnText = document.getElementById('copyBtnText');

    if (nameEl) nameEl.innerText = studentName || 'Student';
    if (classEl) classEl.innerText = studentClass ? `Class: ${studentClass}` : 'Class: N/A';
    if (codeEl) codeEl.innerText = studentId;
    if (copyBtnText) copyBtnText.innerText = 'Copy Code';

    if (modal) modal.classList.remove('hidden');
};

window.closeStudentCodeModal = function () {
    const modal = document.getElementById('studentCodeModal');
    if (modal) modal.classList.add('hidden');
};

window.copyStudentCodeToClipboard = async function () {
    const codeEl = document.getElementById('modalDisplayStudentCode');
    const copyBtnText = document.getElementById('copyBtnText');
    if (!codeEl) return;

    try {
        await navigator.clipboard.writeText(codeEl.innerText.trim());
        if (copyBtnText) {
            copyBtnText.innerText = 'Copied!';
            setTimeout(() => {
                if (copyBtnText) copyBtnText.innerText = 'Copy Code';
            }, 2000);
        }
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = codeEl.innerText.trim();
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        if (copyBtnText) {
            copyBtnText.innerText = 'Copied!';
            setTimeout(() => {
                if (copyBtnText) copyBtnText.innerText = 'Copy Code';
            }, 2000);
        }
    }
};

// --- NATURAL STUDENT SORTING ---
function compareStudentsByClassAndName(a, b) {
    const classA = (a.studentClass || '').trim();
    const classB = (b.studentClass || '').trim();

    // Natural alphanumeric class compare (e.g. Grade 7A < Grade 7B < Grade 10A < Grade 12)
    const classComp = classA.localeCompare(classB, undefined, { numeric: true, sensitivity: 'base' });
    if (classComp !== 0) return classComp;

    // Within same class, compare student names alphabetically (A to Z)
    const nameA = (a.studentName || '').trim();
    const nameB = (b.studentName || '').trim();
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
}

// --- STUDENTS MASTER DIRECTORY (DATABASES TAB) ---
let dbStudentsCurrentPage = 1;

window.onDbStudentSearchChange = debounce(() => {
    dbStudentsCurrentPage = 1;
    renderDbStudentsTable();
}, 200);

window.onDbStudentFilterChange = function () {
    dbStudentsCurrentPage = 1;
    renderDbStudentsTable();
};

window.onDbStudentPerPageChange = function () {
    dbStudentsCurrentPage = 1;
    renderDbStudentsTable();
};

window.goToDbStudentsPage = function (pageNum) {
    dbStudentsCurrentPage = pageNum;
    renderDbStudentsTable();
};

window.renderDbStudentsTable = function () {
    const searchInput = document.getElementById('searchDbStudents');
    const classFilter = document.getElementById('filterDbStudentClass');
    const perPageSelect = document.getElementById('dbStudentsPerPage');
    const tbody = document.querySelector("#dbStudentsDirectoryTable tbody");
    const countBadge = document.getElementById('dbStudentsCountBadge');
    const pageInfo = document.getElementById('dbStudentsPageInfo');
    const pageButtons = document.getElementById('dbStudentsPageButtons');

    if (!tbody) return;

    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const selectedClass = classFilter ? classFilter.value : 'all';
    const perPageVal = perPageSelect ? perPageSelect.value : '10';

    // 1. Filter students
    let filtered = allStudentsData.filter(s => {
        const matchesSearch = !searchTerm ||
            (s.studentName && s.studentName.toLowerCase().includes(searchTerm)) ||
            (s.studentClass && s.studentClass.toLowerCase().includes(searchTerm)) ||
            (s.studentEmail && s.studentEmail.toLowerCase().includes(searchTerm)) ||
            (s.email && s.email.toLowerCase().includes(searchTerm)) ||
            (s.id && s.id.toLowerCase().includes(searchTerm));

        const matchesClass = (selectedClass === 'all') || (s.studentClass === selectedClass);

        return matchesSearch && matchesClass;
    });

    // 2. Sort: lower class first, then student name A-Z
    filtered.sort(compareStudentsByClassAndName);

    // Update total count badge
    if (countBadge) countBadge.innerText = filtered.length;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 30px; color: var(--text-gray);">No matching students found.</td></tr>`;
        if (pageInfo) pageInfo.innerText = 'Showing 0 to 0 of 0 students';
        if (pageButtons) pageButtons.innerHTML = '';
        return;
    }

    // 3. Calculate Pagination
    const perPage = perPageVal === 'all' ? filtered.length : parseInt(perPageVal, 10) || 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));

    if (dbStudentsCurrentPage > totalPages) {
        dbStudentsCurrentPage = totalPages;
    }
    if (dbStudentsCurrentPage < 1) {
        dbStudentsCurrentPage = 1;
    }

    const startIndex = (dbStudentsCurrentPage - 1) * perPage;
    const endIndex = Math.min(filtered.length, startIndex + perPage);
    const paginatedStudents = filtered.slice(startIndex, endIndex);

    // 4. Render Table Rows with Photo, Birth Date & Email
    const rowsHtml = paginatedStudents.map(student => {
        const safeName = (student.studentName || 'Student').replace(/'/g, "\\'");
        const safeClass = (student.studentClass || '').replace(/'/g, "\\'");
        const photoUrl = resolvePhotoUrl(student.photoUrl || student.photo || '');
        const birthDate = student.birthDate || student.dateOfBirth || '-';
        const email = student.studentEmail || student.email || '';

        const photoHtml = photoUrl ?
            `<img src="${photoUrl}" alt="Photo" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1px solid #cbd5e1; display: block; margin: 0 auto;" onerror="this.outerHTML='<div style=\\'width: 32px; height: 32px; border-radius: 50%; background: #f1f5f9; color: #94a3b8; display: flex; align-items: center; justify-content: center; margin: 0 auto; font-size: 14px;\\'>👤</div>'">` :
            `<div style="width: 32px; height: 32px; border-radius: 50%; background: #f1f5f9; color: #94a3b8; display: flex; align-items: center; justify-content: center; margin: 0 auto; font-size: 14px;">👤</div>`;

        const emailHtml = email ?
            `<span style="font-size: 12px; color: var(--text-dark); display: inline-flex; align-items: center; gap: 4px; font-weight: 500;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1e5eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
                ${escapeHtml(email)}
            </span>` :
            `<span style="color: #94a3b8; font-size: 11.5px; font-style: italic;">No email</span>`;

        return `
        <tr>
            <td style="text-align: center;">${photoHtml}</td>
            <td><strong style="font-weight: 600; color: var(--text-dark);">${escapeHtml(student.studentName || 'N/A')}</strong></td>
            <td><span style="color: var(--primary-blue); font-weight: 600;">${escapeHtml(student.studentClass || 'N/A')}</span></td>
            <td><span style="color: var(--text-gray); font-size: 13px;">${escapeHtml(birthDate)}</span></td>
            <td>${emailHtml}</td>
            <td style="text-align: center;">
                <div class="kebab-menu">
                    <button class="kebab-btn" onclick="toggleMenu(event, 'dbstudent-${student.id}')">⋮</button>
                    <div id="menu-dbstudent-${student.id}" class="dropdown-menu">
                        <button class="dropdown-item" onclick="viewStudentCode('${student.id}', '${safeName}', '${safeClass}')">👁️ View Student Code</button>
                        <button class="dropdown-item" onclick="openEditStudentModal('${student.id}')">✏️ Edit Student Profile</button>
                        <button class="dropdown-item" onclick="generateNewUniqueCode('${student.id}')">🔄 Generate New Code</button>
                        <button class="dropdown-item danger" onclick="deleteStudentProfile('${student.id}')">🗑️ Delete Student</button>
                    </div>
                </div>
            </td>
        </tr>
        `;
    });

    tbody.innerHTML = rowsHtml.join('');

    // 5. Render Pagination Info & Buttons
    if (pageInfo) {
        pageInfo.innerText = `Showing ${startIndex + 1} to ${endIndex} of ${filtered.length} students`;
    }

    if (pageButtons) {
        if (totalPages <= 1) {
            pageButtons.innerHTML = '';
        } else {
            let btnsHtml = `
                <button class="db-page-btn" ${dbStudentsCurrentPage === 1 ? 'disabled' : ''} onclick="goToDbStudentsPage(${dbStudentsCurrentPage - 1})">
                    &larr; Prev
                </button>
            `;

            // Smart page number buttons
            let startP = Math.max(1, dbStudentsCurrentPage - 2);
            let endP = Math.min(totalPages, startP + 4);
            if (endP - startP < 4) {
                startP = Math.max(1, endP - 4);
            }

            if (startP > 1) {
                btnsHtml += `<button class="db-page-btn" onclick="goToDbStudentsPage(1)">1</button>`;
                if (startP > 2) btnsHtml += `<span style="padding: 0 4px; color: var(--text-gray);">...</span>`;
            }

            for (let p = startP; p <= endP; p++) {
                btnsHtml += `
                    <button class="db-page-btn ${p === dbStudentsCurrentPage ? 'active' : ''}" onclick="goToDbStudentsPage(${p})">
                        ${p}
                    </button>
                `;
            }

            if (endP < totalPages) {
                if (endP < totalPages - 1) btnsHtml += `<span style="padding: 0 4px; color: var(--text-gray);">...</span>`;
                btnsHtml += `<button class="db-page-btn" onclick="goToDbStudentsPage(${totalPages})">${totalPages}</button>`;
            }

            btnsHtml += `
                <button class="db-page-btn" ${dbStudentsCurrentPage === totalPages ? 'disabled' : ''} onclick="goToDbStudentsPage(${dbStudentsCurrentPage + 1})">
                    Next &rarr;
                </button>
            `;

            pageButtons.innerHTML = btnsHtml;
        }
    }
};

function generateRandomCode(length = 5) {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
}

/**
 * Generates a guaranteed unique 5-character student code.
 * Checks Firestore to ensure the code does not already exist.
 */
async function generateUniqueStudentCode() {
    let isUnique = false;
    let newCode = '';

    while (!isUnique) {
        newCode = generateRandomCode(5);

        // Check if a student document with this code already exists in Firestore
        const studentRef = doc(db, "students", newCode);
        const studentSnap = await getDoc(studentRef);

        // If the snapshot does not exist, the code is unique and safe to use!
        if (!studentSnap.exists()) {
            isUnique = true;
        }
    }

    return newCode;
}

async function registerStudent() {
    const name = document.getElementById('newStudentName').value.trim();
    const studentClass = document.getElementById('newStudentClass').value.trim();
    const birthDate = document.getElementById('newStudentBirthDate')?.value || '';
    const studentEmail = document.getElementById('newStudentEmail')?.value.trim().toLowerCase() || '';

    if (!name || !studentClass) {
        alert("Please provide both Student Name and Class assignment.");
        return;
    }

    try {
        const dupQuery = query(collection(db, "students"), where("studentName", "==", name), where("studentClass", "==", studentClass));
        const dupSnap = await getDocs(dupQuery);

        if (!dupSnap.empty) {
            alert(`Profile collision! This student is already registered with code: ${dupSnap.docs[0].id}`);
            return;
        }

        const uniqueCode = await generateUniqueStudentCode();
        await setDoc(doc(db, "students", uniqueCode), {
            studentName: name,
            studentClass: studentClass,
            birthDate: birthDate,
            studentEmail: studentEmail,
            photoUrl: ""
        });

        alert(`Profile Confirmed!\nName: ${name}\nClass: ${studentClass}\nCode: ${uniqueCode}${studentEmail ? `\nEmail: ${studentEmail}` : ''}`);
        document.getElementById('newStudentName').value = "";
        document.getElementById('newStudentClass').value = "";
        if (document.getElementById('newStudentBirthDate')) document.getElementById('newStudentBirthDate').value = "";
        if (document.getElementById('newStudentEmail')) document.getElementById('newStudentEmail').value = "";
        loadStudentsDirectory();
        loadPointsTable(); // Refresh points table to include new student
    } catch (e) {
        alert("System error tracking record: " + e.message);
    }
}

// Global variable to store student data for fast searching/sorting
let allStudentsData = [];

// 1. Function to fetch data and build the filter dropdown
async function loadStudentsDirectory() {
    try {
        const querySnapshot = await getDocs(collection(db, "students"));
        allStudentsData = [];
        const classesSet = new Set(); // To collect unique class names automatically

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            allStudentsData.push({ id: doc.id, ...data });

            if (data.studentClass) {
                classesSet.add(data.studentClass.trim());
            }
        });

        // Naturally sort classes (e.g., Grade 7A, Grade 7B, Grade 10A, Grade 12)
        const sortedClasses = Array.from(classesSet).filter(Boolean).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );

        // Populate Database Class Filter dropdown
        const dbClassFilter = document.getElementById('filterDbStudentClass');
        if (dbClassFilter) {
            const currentSelected = dbClassFilter.value;
            let optionsHtml = '<option value="all">All Classes</option>';
            sortedClasses.forEach(className => {
                optionsHtml += `<option value="${className}">${className}</option>`;
            });
            dbClassFilter.innerHTML = optionsHtml;
            if (sortedClasses.includes(currentSelected)) {
                dbClassFilter.value = currentSelected;
            }
        }

        // Populate legacy filterClass dropdown if present
        const filterDropdown = document.getElementById('filterClass');
        if (filterDropdown) {
            filterDropdown.innerHTML = '<option value="all">All Classes</option>';
            sortedClasses.forEach(className => {
                filterDropdown.innerHTML += `<option value="${className}">${className}</option>`;
            });
        }

        // Populate Active Classes Table
        const classesTbody = document.querySelector("#classesTable tbody");
        if (classesTbody) {
            if (sortedClasses.length === 0) {
                classesTbody.innerHTML = `<tr><td colspan="2" style="text-align: center; color: var(--text-gray);">No classes found.</td></tr>`;
            } else {
                classesTbody.innerHTML = sortedClasses.map(cls => `
                    <tr>
                        <td><strong>${cls}</strong></td>
                        <td><span style="color: #64748b; font-size: 13px;">Auto-detected from Students</span></td>
                    </tr>
                `).join('');
            }
        }

        if (typeof renderStudentsTable === "function") {
            renderStudentsTable();
        }
        if (typeof renderDbStudentsTable === "function") {
            renderDbStudentsTable();
        }
    } catch (error) {
        console.error("Error loading students:", error);
    }
}

// --- PHOTO & URL RESOLVER ---
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

// Resize image to max 400x400 data URL for lightweight, high-speed storage
function resizeImageToDataUrl(file, maxWidth = 400, maxHeight = 400, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > maxWidth || height > maxHeight) {
                    if (width > height) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    } else {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL(file.type || 'image/jpeg', quality));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Optional Google Apps Script uploader bridge
async function uploadPhotoToDriveOrDirect(file, dataUrl, scriptUrl) {
    if (scriptUrl) {
        try {
            const base64Data = dataUrl.split(',')[1];
            const response = await fetch(scriptUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({
                    fileName: file.name,
                    mimeType: file.type || 'image/jpeg',
                    base64Data: base64Data,
                    folderName: "picdb",
                    replaceExisting: true
                })
            });
            const resJson = await response.json();
            if (resJson.status === 'success' && resJson.photoUrl) {
                return resJson.photoUrl;
            }
        } catch (e) {
            console.warn("Google Drive Web App upload error, saving direct image:", e);
        }
    }
    return dataUrl;
}

// --- BULK PHOTO PROCESSING ---
async function processBulkPhotoFiles(files) {
    if (!files || files.length === 0) return;
    const resultsContainer = document.getElementById('bulkPhotoResults');
    if (resultsContainer) {
        resultsContainer.classList.remove('hidden');
        resultsContainer.innerHTML = `
            <div style="padding: 16px; background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 12px; text-align: center;">
                <div style="font-size: 14px; font-weight: 700; color: var(--primary-blue);">
                    🔄 Processing & Matching ${files.length} photo(s)...
                </div>
                <div style="font-size: 12px; color: var(--text-gray); margin-top: 4px;">
                    Please wait while photos are optimized and linked to student profiles.
                </div>
            </div>
        `;
    }

    const scriptUrl = localStorage.getItem('googleDriveScriptUrl') || document.getElementById('googleDriveScriptUrl')?.value.trim() || '';

    try {
        const studentsSnap = await getDocs(collection(db, "students"));
        const students = [];
        studentsSnap.forEach(docSnap => {
            students.push({ id: docSnap.id, ...docSnap.data() });
        });

        const matched = [];
        const unmatched = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file.type.startsWith('image/')) {
                unmatched.push({ name: file.name, reason: "Not an image file" });
                continue;
            }

            const rawName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
            const cleanIdentifier = rawName.trim().toLowerCase();

            const targetStudent = students.find(s => {
                const sCode = (s.id || '').trim().toLowerCase();
                const sCodeField = (s.studentCode || '').trim().toLowerCase();
                const sName = (s.studentName || '').trim().toLowerCase();
                return sCode === cleanIdentifier || sCodeField === cleanIdentifier || sName === cleanIdentifier;
            });

            if (targetStudent) {
                try {
                    const dataUrl = await resizeImageToDataUrl(file);
                    const finalUrl = await uploadPhotoToDriveOrDirect(file, dataUrl, scriptUrl);

                    await updateDoc(doc(db, "students", targetStudent.id), {
                        photoUrl: finalUrl
                    });

                    matched.push({
                        name: targetStudent.studentName,
                        code: targetStudent.id,
                        sClass: targetStudent.studentClass,
                        photoUrl: finalUrl
                    });
                } catch (err) {
                    unmatched.push({ name: file.name, reason: "Save error: " + err.message });
                }
            } else {
                unmatched.push({ name: file.name, reason: "No student matching code or name" });
            }
        }

        if (resultsContainer) {
            resultsContainer.innerHTML = `
                <div style="background: var(--card-bg, #ffffff); border: 1px solid var(--border-color); border-radius: 12px; padding: 18px; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px;">
                        <h4 style="margin: 0; font-size: 15px; color: var(--text-dark);">
                            📸 Bulk Photo Upload Summary
                        </h4>
                        <span style="font-size: 12px; font-weight: 700; color: #16a34a; background: #dcfce7; padding: 3px 10px; border-radius: 12px;">
                            ✅ ${matched.length} Matched / ${files.length} Total
                        </span>
                    </div>

                    ${matched.length > 0 ? `
                        <div style="margin-bottom: 14px;">
                            <div style="font-size: 12px; font-weight: 700; color: var(--text-dark); margin-bottom: 8px;">
                                Successfully Linked Profiles:
                            </div>
                            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; max-height: 240px; overflow-y: auto; padding: 4px;">
                                ${matched.map(m => `
                                    <div style="display: flex; align-items: center; gap: 8px; background: var(--bg-color); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color);">
                                        <img src="${m.photoUrl}" alt="Photo" style="width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 1px solid #cbd5e1;">
                                        <div style="overflow: hidden;">
                                            <div style="font-size: 12.5px; font-weight: 700; color: var(--text-dark); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${m.name}</div>
                                            <div style="font-size: 11px; color: var(--primary-blue); font-family: monospace;">${m.code} (${m.sClass || 'N/A'})</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}

                    ${unmatched.length > 0 ? `
                        <div style="background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 12px; margin-top: 10px;">
                            <div style="font-size: 12px; font-weight: 700; color: #b45309; margin-bottom: 6px;">
                                ⚠️ Unmatched Files (${unmatched.length}):
                            </div>
                            <div style="font-size: 12px; color: #92400e; max-height: 120px; overflow-y: auto;">
                                ${unmatched.map(u => `<div>• <strong>${u.name}</strong> - ${u.reason}</div>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        loadStudentsDirectory();
    } catch (e) {
        alert("Error during bulk photo matching: " + e.message);
    }
}

// --- GOOGLE DRIVE SCRIPT SETTINGS (PERMANENT FIRESTORE CONFIG) ---
window.loadAdminDriveSettings = async function () {
    try {
        let profileUrl = localStorage.getItem('profileDriveScriptUrl') || localStorage.getItem('googleDriveScriptUrl') || '';
        let profileFolderId = localStorage.getItem('profileDriveFolderId') || '';

        let timelineUrl = localStorage.getItem('timelineDriveScriptUrl') || localStorage.getItem('googleDriveScriptUrl') || '';
        let timelineFolderId = localStorage.getItem('timelineDriveFolderId') || '';

        let weeklyUrl = localStorage.getItem('meetingDriveScriptUrl') || localStorage.getItem('weeklyDriveScriptUrl') || '';
        let weeklyFolderId = localStorage.getItem('meetingDriveFolderId') || '';

        // Try loading from Firestore system_settings/google_drive first, then googleDrive
        try {
            let snap = await getDoc(doc(db, "system_settings", "google_drive"));
            if (!snap.exists()) {
                snap = await getDoc(doc(db, "system_settings", "googleDrive"));
            }

            if (snap.exists()) {
                const data = snap.data();
                profileUrl = data.profileScriptUrl || data.scriptUrlProfile || profileUrl || data.scriptUrl;
                profileFolderId = data.profileFolderId || data.folderIdProfile || profileFolderId;

                timelineUrl = data.timelineScriptUrl || data.scriptUrlTimeline || timelineUrl || data.scriptUrl;
                timelineFolderId = data.timelineFolderId || data.folderIdTimeline || timelineFolderId || data.folderId;

                weeklyUrl = data.weeklyScriptUrl || data.scriptUrlWeekly || data.meetingScriptUrl || weeklyUrl;
                weeklyFolderId = data.weeklyFolderId || data.folderIdWeekly || data.meetingFolderId || weeklyFolderId;
            }
        } catch (fErr) {
            console.warn("Could not fetch Firestore system_settings/google_drive:", fErr);
        }

        const inProfileUrl = document.getElementById('scriptUrlProfile');
        const inProfileFolderId = document.getElementById('folderIdProfile');
        const inTimelineUrl = document.getElementById('scriptUrlTimeline');
        const inTimelineFolderId = document.getElementById('folderIdTimeline');
        const inWeeklyUrl = document.getElementById('scriptUrlWeekly');
        const inWeeklyFolderId = document.getElementById('folderIdWeekly');

        if (inProfileUrl) inProfileUrl.value = profileUrl;
        if (inProfileFolderId) inProfileFolderId.value = profileFolderId;
        if (inTimelineUrl) inTimelineUrl.value = timelineUrl;
        if (inTimelineFolderId) inTimelineFolderId.value = timelineFolderId;
        if (inWeeklyUrl) inWeeklyUrl.value = weeklyUrl;
        if (inWeeklyFolderId) inWeeklyFolderId.value = weeklyFolderId;

        const bulkScriptInput = document.getElementById('googleDriveScriptUrl');
        if (bulkScriptInput) bulkScriptInput.value = profileUrl;

        // Synchronize local storage
        if (profileUrl) {
            localStorage.setItem('googleDriveScriptUrl', profileUrl);
            localStorage.setItem('profileDriveScriptUrl', profileUrl);
        }
        if (profileFolderId) localStorage.setItem('profileDriveFolderId', profileFolderId);

        if (timelineUrl) localStorage.setItem('timelineDriveScriptUrl', timelineUrl);
        if (timelineFolderId) localStorage.setItem('timelineDriveFolderId', timelineFolderId);

        if (weeklyUrl) localStorage.setItem('meetingDriveScriptUrl', weeklyUrl);
        if (weeklyFolderId) localStorage.setItem('meetingDriveFolderId', weeklyFolderId);

    } catch (e) {
        console.warn("Could not load Google Drive settings from Firestore:", e);
    }
};

window.saveAdminDriveSettings = async function () {
    const profileUrl = document.getElementById('scriptUrlProfile')?.value.trim() || '';
    const profileFolderId = document.getElementById('folderIdProfile')?.value.trim() || '';

    const timelineUrl = document.getElementById('scriptUrlTimeline')?.value.trim() || '';
    const timelineFolderId = document.getElementById('folderIdTimeline')?.value.trim() || '';

    const weeklyUrl = document.getElementById('scriptUrlWeekly')?.value.trim() || '';
    const weeklyFolderId = document.getElementById('folderIdWeekly')?.value.trim() || '';

    const msgEl = document.getElementById('scriptingSaveMsg');

    try {
        const payload = {
            // 1. Profile photos (picdb)
            profileScriptUrl: profileUrl,
            profileFolderId: profileFolderId,
            profileFolderName: "picdb",

            // 2. Timeline uploads (TimelineDB)
            timelineScriptUrl: timelineUrl,
            timelineFolderId: timelineFolderId,
            timelineFolderName: "TimelineDB",
            scriptUrl: timelineUrl, // fallback
            folderId: timelineFolderId,

            // 3. Weekly / Meeting coordination reports (Meeting Coordination)
            weeklyScriptUrl: weeklyUrl,
            weeklyFolderId: weeklyFolderId,
            weeklyFolderName: "Meeting Coordination",
            meetingScriptUrl: weeklyUrl,

            updatedAt: new Date().toISOString(),
            updatedBy: auth.currentUser?.email || 'admin'
        };

        // Save to both document keys for bulletproof compatibility
        await setDoc(doc(db, "system_settings", "google_drive"), payload, { merge: true });
        await setDoc(doc(db, "system_settings", "googleDrive"), payload, { merge: true });

        // Update local storage
        if (profileUrl) {
            localStorage.setItem('googleDriveScriptUrl', profileUrl);
            localStorage.setItem('profileDriveScriptUrl', profileUrl);
        } else {
            localStorage.removeItem('googleDriveScriptUrl');
            localStorage.removeItem('profileDriveScriptUrl');
        }
        if (profileFolderId) {
            localStorage.setItem('profileDriveFolderId', profileFolderId);
        } else {
            localStorage.removeItem('profileDriveFolderId');
        }

        if (timelineUrl) {
            localStorage.setItem('timelineDriveScriptUrl', timelineUrl);
        } else {
            localStorage.removeItem('timelineDriveScriptUrl');
        }
        if (timelineFolderId) {
            localStorage.setItem('timelineDriveFolderId', timelineFolderId);
        } else {
            localStorage.removeItem('timelineDriveFolderId');
        }

        if (weeklyUrl) {
            localStorage.setItem('meetingDriveScriptUrl', weeklyUrl);
        } else {
            localStorage.removeItem('meetingDriveScriptUrl');
        }
        if (weeklyFolderId) {
            localStorage.setItem('meetingDriveFolderId', weeklyFolderId);
        } else {
            localStorage.removeItem('meetingDriveFolderId');
        }

        const bulkScriptInput = document.getElementById('googleDriveScriptUrl');
        if (bulkScriptInput) bulkScriptInput.value = profileUrl;

        if (msgEl) {
            msgEl.innerText = "✅ All 3 Google Drive Scripts saved permanently to Firestore!";
            msgEl.style.color = "#16a34a";
            setTimeout(() => { if (msgEl) msgEl.innerText = ""; }, 4000);
        }

        alert("All 3 Google Drive script configurations have been saved successfully to Firestore and applied across the app!");
    } catch (err) {
        console.error("Error saving scripts to Firestore:", err);
        if (msgEl) {
            msgEl.innerText = "❌ Error: " + err.message;
            msgEl.style.color = "#ef4444";
        }
        alert("Failed to save settings: " + err.message);
    }
};

window.toggleDriveScriptSettings = async function () {
    const box = document.getElementById('driveScriptSettingsBox');
    if (box) box.classList.toggle('hidden');
    window.loadAdminDriveSettings();
};

window.saveDriveScriptUrl = async function () {
    const input = document.getElementById('googleDriveScriptUrl');
    const url = input?.value.trim() || '';
    const folderId = localStorage.getItem('timelineDriveFolderId') || '';

    const payload = {
        scriptUrl: url,
        folderId: folderId,
        folderName: "TimelineDB",
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser?.email || 'admin'
    };

    localStorage.setItem('googleDriveScriptUrl', url);
    localStorage.setItem('timelineDriveScriptUrl', url);
    try {
        await setDoc(doc(db, "system_settings", "google_drive"), payload, { merge: true });
        await setDoc(doc(db, "system_settings", "googleDrive"), payload, { merge: true });
    } catch (e) {
        console.warn("Could not save to Firestore system_settings:", e);
    }
    const adminScriptInput = document.getElementById('adminDriveScriptUrl');
    if (adminScriptInput) adminScriptInput.value = url;
    alert("Google Drive Web App Script URL saved & synced to Firestore permanently!");
};

// --- EDIT STUDENT PROFILE MODAL ---
window.openEditStudentModal = async function (studentId) {
    try {
        const studentRef = doc(db, "students", studentId);
        const studentSnap = await getDoc(studentRef);
        if (!studentSnap.exists()) return alert("Student record missing.");
        const data = studentSnap.data();

        document.getElementById('editStudentId').value = studentId;
        document.getElementById('editStudentDisplayCode').innerText = studentId;
        document.getElementById('editStudentNameInput').value = data.studentName || '';
        document.getElementById('editStudentClassInput').value = data.studentClass || data.Class || data.class || '';
        document.getElementById('editStudentBirthDateInput').value = data.birthDate || data.dateOfBirth || '';
        if (document.getElementById('editStudentEmailInput')) {
            document.getElementById('editStudentEmailInput').value = data.studentEmail || data.email || '';
        }
        document.getElementById('editStudentPhotoUrlInput').value = data.photoUrl || data.photo || '';

        const preview = document.getElementById('editStudentPhotoPreview');
        const placeholder = document.getElementById('editStudentPhotoPlaceholder');
        const photoUrl = resolvePhotoUrl(data.photoUrl || data.photo || '');
        if (photoUrl) {
            preview.src = photoUrl;
            preview.style.display = 'block';
            placeholder.style.display = 'none';
        } else {
            preview.style.display = 'none';
            placeholder.style.display = 'block';
        }

        document.getElementById('editStudentProfileModal')?.classList.remove('hidden');
    } catch (e) {
        alert("Error loading student: " + e.message);
    }
};

window.editStudentProfile = window.openEditStudentModal;

window.closeEditStudentModal = function () {
    document.getElementById('editStudentProfileModal')?.classList.add('hidden');
};

window.onEditPhotoUrlChange = function () {
    const url = document.getElementById('editStudentPhotoUrlInput')?.value.trim() || '';
    const preview = document.getElementById('editStudentPhotoPreview');
    const placeholder = document.getElementById('editStudentPhotoPlaceholder');
    const resolved = resolvePhotoUrl(url);
    if (resolved) {
        preview.src = resolved;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
    } else {
        preview.style.display = 'none';
        placeholder.style.display = 'block';
    }
};

window.onEditPhotoFileChange = async function (event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        const dataUrl = await resizeImageToDataUrl(file);
        const scriptUrl = localStorage.getItem('googleDriveScriptUrl') || '';
        const finalUrl = await uploadPhotoToDriveOrDirect(file, dataUrl, scriptUrl);
        document.getElementById('editStudentPhotoUrlInput').value = finalUrl;
        window.onEditPhotoUrlChange();
    } catch (e) {
        alert("Error reading photo file: " + e.message);
    }
};

window.saveEditStudentProfile = async function () {
    const studentId = document.getElementById('editStudentId').value;
    const name = document.getElementById('editStudentNameInput').value.trim();
    const sClass = document.getElementById('editStudentClassInput').value.trim();
    const birthDate = document.getElementById('editStudentBirthDateInput').value;
    const email = document.getElementById('editStudentEmailInput')?.value.trim().toLowerCase() || '';
    const photoUrl = document.getElementById('editStudentPhotoUrlInput').value.trim();

    if (!name || !sClass) {
        return alert("Name and Class cannot be empty.");
    }

    try {
        await updateDoc(doc(db, "students", studentId), {
            studentName: name,
            studentClass: sClass,
            birthDate: birthDate,
            studentEmail: email,
            photoUrl: photoUrl
        });

        alert("Student profile updated successfully!");
        closeEditStudentModal();
        loadStudentsDirectory();
        loadAdminTable();
        loadPointsTable();
    } catch (e) {
        alert("Error saving profile: " + e.message);
    }
};

// Student Directory Wiping Handler
async function deleteStudentProfile(studentCode) {
    if (confirm(`Are you sure you want to permanently delete student registration code ${studentCode} from the directory?\n(This actions does not clear recorded exam score blocks).`)) {
        try {
            await deleteDoc(doc(db, "students", studentCode));
            alert("Directory signature removed.");
            loadStudentsDirectory();
            loadPointsTable();
        } catch (e) {
            alert("Error removing directory entry: " + e.message);
        }
    }
}

async function addStudentScore() {
    const code = document.getElementById('scoreStudentCode').value.toUpperCase().trim();
    const examName = document.getElementById('examName').value.trim();
    const subject = userRole === "admin" ? document.getElementById('subject').value.trim() : teacherSubject;
    const score = parseInt(document.getElementById('score').value);

    if (!code || !examName || !subject || isNaN(score)) {
        alert("Please complete all entry fields.");
        return;
    }

    try {
        const studentSnap = await getDoc(doc(db, "students", code));
        if (!studentSnap.exists()) {
            alert(`Lookup Error: Student code "${code}" does not exist in the active directory registration system.`);
            return;
        }

        const sData = studentSnap.data();
        const targetClass = sData.studentClass || sData.Class || sData.class || 'N/A';

        await addDoc(collection(db, "exam_scores"), {
            studentCode: code,
            studentName: sData.studentName,
            studentClass: targetClass,
            examName: examName,
            subject: subject,
            score: score
        });

        alert("Score logged successfully!");
        document.getElementById('scoreStudentCode').value = "";
        document.getElementById('score').value = "";
        loadAdminTable();
    } catch (e) {
        alert("Error logging exam document transaction: " + e.message);
    }
}

async function deleteStudentScore(docId) {
    if (confirm("Permanently wipe this score entry from the ledger?")) {
        try {
            await deleteDoc(doc(db, "exam_scores", docId));
            loadAdminTable();
        } catch (e) {
            alert("Transaction error: " + e.message);
        }
    }
}

// CORRECTED TABLE RENDERING METHOD WITH NO-SHIFT FAILSAFE CELL DESIGNATIONS
async function loadAdminTable() {
    const user = auth.currentUser;
    if (!user) return;

    try {
        let q = (userRole === "admin")
            ? query(collection(db, "exam_scores"))
            : query(collection(db, "exam_scores"), where("subject", "==", teacherSubject));

        const querySnapshot = await getDocs(q);
        const tbody = document.querySelector("#adminTable tbody");
        if (!tbody) return;

        let scoresList = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            scoresList.push({
                docId: doc.id,
                exam: data.examName || 'N/A',
                sub: data.subject || 'N/A',
                sName: data.studentName || 'N/A',
                sClass: data.studentClass || data.Class || data.class || 'N/A',
                sCode: data.studentCode || (doc.id.length === 5 ? doc.id : 'N/A'),
                score: data.score !== undefined ? data.score : 0
            });
        });
        const filterDropdown = document.getElementById('filterScoreClass');
        if (filterDropdown) {
            const currentFilter = filterDropdown.value;
            const uniqueClasses = [...new Set(scoresList.map(item => item.sClass))].filter(c => c !== 'N/A').sort();

            // Rebuild dropdown options dynamically
            filterDropdown.innerHTML = '<option value="all">All Classes</option>';
            uniqueClasses.forEach(c => {
                filterDropdown.innerHTML += `<option value="${c}">${c}</option>`;
            });

            // Restore selection and apply filter
            if (uniqueClasses.includes(currentFilter)) {
                filterDropdown.value = currentFilter;
                scoresList = scoresList.filter(item => item.sClass === currentFilter);
            } else {
                filterDropdown.value = 'all';
            }
        }
        // Apply Sorting
        const sortVal = document.getElementById('sortScores')?.value || 'default';
        scoresList.sort((a, b) => {
            if (sortVal === 'name') return a.sName.localeCompare(b.sName);
            if (sortVal === 'class') return a.sClass.localeCompare(b.sClass);
            if (sortVal === 'scoreDesc') return b.score - a.score;
            if (sortVal === 'scoreAsc') return a.score - b.score;
            return 0;
        });

        tbody.innerHTML = "";
        scoresList.forEach((data) => {
            tbody.innerHTML += `<tr>
                <td>${data.exam}</td>
                <td>${data.sub}</td>
                <td>${data.sName}</td>
                <td><strong>${data.sClass}</strong></td>
                <td><strong>${data.sCode}</strong></td>
                <td><strong style="color: #28a745;">${data.score}</strong></td>
                <td><button class="delete-btn" onclick="deleteStudentScore('${data.docId}')">Delete</button></td>
            </tr>`;
        });
    } catch (e) {
        console.error("Table processing crash encountered: ", e);
    }
}

// --- BULK EXCEL PROCESSOR & FIRESTORE SYNCHRONIZER ---
async function processExcel() {
    const fileInput = document.getElementById('excelFile');
    const file = fileInput ? fileInput.files[0] : null;
    if (!file) return alert("Select an Excel (.xlsx) file to upload first.");

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

            if (!rawRows || rawRows.length === 0) {
                alert("The uploaded Excel file appears to be empty.");
                return;
            }

            let topSubject = "";
            let topClass = "";
            let topExamName = "";
            let headerRowIndex = -1;
            let colMap = {};

            // 1. Scan the first 10 rows for metadata & table headers
            for (let r = 0; r < Math.min(rawRows.length, 10); r++) {
                const row = rawRows[r] || [];
                const firstCell = String(row[0] || "").trim().toLowerCase();
                const secondCell = String(row[1] || "").trim();

                if (firstCell.includes("subject")) {
                    topSubject = secondCell || String(row[2] || "").trim();
                } else if (firstCell.includes("class")) {
                    topClass = secondCell || String(row[2] || "").trim();
                } else if (firstCell.includes("exam") || firstCell.includes("quiz")) {
                    topExamName = secondCell || String(row[2] || "").trim();
                }

                // Identify the table header row
                const rowCells = row.map(c => String(c || "").trim().toLowerCase());
                if (rowCells.some(c => c.includes("student") || c.includes("code") || c.includes("score"))) {
                    headerRowIndex = r;
                    row.forEach((cellVal, cIdx) => {
                        const h = String(cellVal || "").trim().toLowerCase();
                        if (h.includes("code")) colMap.code = cIdx;
                        else if (h.includes("name") && !h.includes("exam") && !h.includes("quiz")) colMap.name = cIdx;
                        else if (h.includes("score")) colMap.score = cIdx;
                        else if (h.includes("class")) colMap.sClass = cIdx;
                        else if (h.includes("subject")) colMap.subject = cIdx;
                        else if (h.includes("exam") || h.includes("quiz")) colMap.examName = cIdx;
                    });
                    break;
                }
            }

            // Fetch quiz types mapping from quizzes and system_quizzes
            const quizTypeMap = {};
            try {
                const [quizzesSnap, sysQuizzesSnap] = await Promise.all([
                    getDocs(collection(db, "quizzes")),
                    getDocs(collection(db, "system_quizzes"))
                ]);
                quizzesSnap.forEach(d => {
                    const data = d.data();
                    const t = (data.title || data.quizName || data.name || d.id).trim().toLowerCase();
                    if (data.type && t) quizTypeMap[t] = data.type;
                });
                sysQuizzesSnap.forEach(d => {
                    const data = d.data();
                    const t = (data.name || data.title || data.quizName || d.id).trim().toLowerCase();
                    if (data.type && t) quizTypeMap[t] = data.type;
                });
            } catch (te) {
                console.warn("Could not fetch quiz types for excel sync:", te);
            }

            // Fallback: If header row wasn't detected, try standard JSON parse
            if (headerRowIndex === -1 || colMap.code === undefined || colMap.score === undefined) {
                const jsonData = XLSX.utils.sheet_to_json(sheet);
                let successCount = 0;
                let skippedCount = 0;

                for (const row of jsonData) {
                    const code = String(row["Student Code"] || row["Code"] || "").toUpperCase().trim();
                    const name = String(row["Student Name"] || row["Name"] || "").trim();
                    const sClass = String(row["Class"] || topClass || "").trim();
                    const examName = String(row["Exam Name"] || row["Exam"] || row["Quiz Name"] || topExamName || "").trim();
                    const fileSubject = String(row["Subject"] || topSubject || "").trim();
                    const subject = userRole === "admin" ? fileSubject : teacherSubject;

                    const rawScore = row["Score"] !== undefined ? row["Score"] : row["score"];
                    if (rawScore === undefined || rawScore === null || rawScore === "") continue;
                    const score = parseInt(rawScore);

                    if (userRole !== "admin" && fileSubject && fileSubject.toLowerCase() !== teacherSubject.toLowerCase()) {
                        skippedCount++;
                        continue;
                    }

                    if (code && examName && subject && !isNaN(score)) {
                        const customDocId = `${code}_${subject}_${examName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
                        const resolvedType = quizTypeMap[examName.toLowerCase()] || resolveQuizType(examName);

                        await setDoc(doc(db, "exam_scores", customDocId), {
                            studentCode: code,
                            studentName: name || "Unknown",
                            studentClass: sClass || "N/A",
                            examName: examName,
                            quizName: examName,
                            subject: subject,
                            type: resolvedType,
                            score: score,
                            updatedAt: new Date()
                        }, { merge: true });
                        successCount++;
                    }
                }

                alert(`Excel Process Complete!\nUpdated/Saved: ${successCount} entries${skippedCount > 0 ? `\nSkipped (Unauthorized Subject): ${skippedCount}` : ''}`);
                fileInput.value = "";
                if (typeof loadAdminTable === "function") loadAdminTable();
                return;
            }

            let successCount = 0;
            let skippedCount = 0;

            // 2. Iterate through student score data rows
            for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
                const row = rawRows[r] || [];
                if (!row || row.length === 0) continue;

                const code = String(colMap.code !== undefined ? (row[colMap.code] || "") : "").toUpperCase().trim();
                const name = String(colMap.name !== undefined ? (row[colMap.name] || "") : "").trim();
                const sClass = String((colMap.sClass !== undefined && row[colMap.sClass]) ? row[colMap.sClass] : topClass).trim();
                const fileSubject = String((colMap.subject !== undefined && row[colMap.subject]) ? row[colMap.subject] : topSubject).trim();
                const examName = String((colMap.examName !== undefined && row[colMap.examName]) ? row[colMap.examName] : topExamName).trim();
                const subject = userRole === "admin" ? fileSubject : teacherSubject;

                const rawScore = colMap.score !== undefined ? row[colMap.score] : "";
                if (rawScore === "" || rawScore === undefined || rawScore === null) continue;
                const score = parseInt(rawScore);

                // Check authorization for non-admin teachers
                if (userRole !== "admin" && fileSubject && fileSubject.toLowerCase() !== teacherSubject.toLowerCase()) {
                    skippedCount++;
                    continue;
                }

                if (code && examName && subject && !isNaN(score)) {
                    const customDocId = `${code}_${subject}_${examName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
                    const resolvedType = quizTypeMap[examName.toLowerCase()] || resolveQuizType(examName);

                    await setDoc(doc(db, "exam_scores", customDocId), {
                        studentCode: code,
                        studentName: name || "Unknown",
                        studentClass: sClass || "N/A",
                        examName: examName,
                        quizName: examName,
                        subject: subject,
                        type: resolvedType,
                        score: score,
                        updatedAt: new Date()
                    }, { merge: true });

                    successCount++;
                }
            }

            alert(`Excel Process Complete!\nUpdated/Saved: ${successCount} entries${skippedCount > 0 ? `\nSkipped (Unauthorized Subject): ${skippedCount}` : ''}`);
            fileInput.value = "";

            if (typeof loadAdminTable === "function") loadAdminTable();

        } catch (err) {
            console.error("Error processing Excel file:", err);
            alert("Error processing Excel file: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

// Re-bind upload button
document.getElementById('uploadExcelBtn')?.addEventListener('click', processExcel);

// Function to handle saving point transactions
async function processStudentPoint(pointValue) {
    const studentNameInput = document.getElementById('pointStudentName').value.trim();
    const reason = document.getElementById('pointReason').value.trim();

    if (!studentNameInput || !reason || isNaN(pointValue)) {
        alert("Please ensure Student Name, Reason, and a valid point value are provided.");
        return;
    }

    try {
        // Find the student code based on the typed name
        const studentMatch = allStudentsData.find(s => s.studentName.toLowerCase() === studentNameInput.toLowerCase());

        if (!studentMatch) {
            alert(`Lookup Error: Student "${studentNameInput}" does not exist in the directory. Please use the autocomplete dropdown.`);
            return;
        }

        const code = studentMatch.id;
        const targetClass = studentMatch.studentClass || studentMatch.Class || studentMatch.class || 'N/A';

        await addDoc(collection(db, "student_points"), {
            studentCode: code,
            studentName: studentMatch.studentName,
            studentClass: targetClass,
            reason: reason,
            points: parseFloat(pointValue),
            timestamp: new Date()
        });

        const sign = pointValue > 0 ? '+' : '';
        alert(`Successfully recorded ${sign}${pointValue} points for ${studentMatch.studentName}.`);

        // Reset the form inputs
        document.getElementById('pointStudentName').value = "";
        document.getElementById('pointReason').value = "";
        document.getElementById('customPointValue').value = "";

        // Refresh ledgers
        loadPointsTable();
        refreshBehaviorTabLedgers();

    } catch (e) {
        alert("Error logging point transaction: " + e.message);
    }
}

// Function to calculate and render the points ledger
async function loadPointsTable() {
    const user = auth.currentUser;
    if (!user) return;

    try {
        const studentsSnap = await getDocs(collection(db, "students"));
        const studentsMap = {};

        studentsSnap.forEach(doc => {
            const data = doc.data();
            studentsMap[doc.id] = {
                code: doc.id,
                name: data.studentName || 'N/A',
                sClass: data.studentClass || data.Class || data.class || 'N/A',
                total: 0
            };
        });

        const pointsSnap = await getDocs(collection(db, "student_points"));
        pointsSnap.forEach(doc => {
            const data = doc.data();
            const code = data.studentCode;
            if (studentsMap[code]) {
                studentsMap[code].total += (parseFloat(data.points) || 0);
            }
        });

        let pointsList = Object.values(studentsMap);

        // Apply Sorting
        const sortVal = document.getElementById('sortPoints')?.value || 'default';
        pointsList.sort((a, b) => {
            if (sortVal === 'name') return a.name.localeCompare(b.name);
            if (sortVal === 'class') return a.sClass.localeCompare(b.sClass);
            if (sortVal === 'pointsDesc') return b.total - a.total;
            if (sortVal === 'pointsAsc') return a.total - b.total;
            return 0;
        });
        const filterDropdown = document.getElementById('filterPointsClass');
        if (filterDropdown) {
            const currentFilter = filterDropdown.value;
            const uniqueClasses = [...new Set(pointsList.map(item => item.sClass))].filter(c => c !== 'N/A').sort();

            filterDropdown.innerHTML = '<option value="all">All Classes</option>';
            uniqueClasses.forEach(c => {
                filterDropdown.innerHTML += `<option value="${c}">${c}</option>`;
            });

            if (uniqueClasses.includes(currentFilter)) {
                filterDropdown.value = currentFilter;
                pointsList = pointsList.filter(item => item.sClass === currentFilter);
            } else {
                filterDropdown.value = 'all';
            }
        }
        const tbody = document.querySelector("#pointsTable tbody");
        if (tbody) {
            tbody.innerHTML = "";
            pointsList.forEach(info => {
                const color = info.total > 0 ? '#28a745' : (info.total < 0 ? '#dc3545' : '#333');
                const sign = info.total > 0 ? '+' : '';

                tbody.innerHTML += `<tr>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span id="pt-code-${info.code}" style="font-weight: 600; letter-spacing: 2px;">•••••</span>
                            <button class="eye-btn" onclick="togglePtCodeVisibility('${info.code}')" title="Show/Hide Code">
                                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                                    <path d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0"/>
                                    <path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8m8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7"/>
                                </svg>
                            </button>
                        </div>
                    </td>
                    <td>${info.name}</td>
                    <td><strong>${info.sClass}</strong></td>
                    <td><strong style="color: ${color}; font-size: 16px;">${sign}${info.total}</strong></td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleMenu(event, 'pt-${info.code}')">⋮</button>
                            <div id="menu-pt-${info.code}" class="dropdown-menu">
                                <button class="dropdown-item" onclick="openPointModal('${info.code}', '${info.name.replace(/'/g, "\\'")}')">Add / Subtract Point</button>
                                <button class="dropdown-item danger" onclick="resetStudentPoints('${info.code}')">Reset Points</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            });
        }
    } catch (e) {
        console.error("Error loading points table:", e);
    }
}

// Bind basic events
document.getElementById('loginBtn').addEventListener('click', loginAdmin);
document.getElementById('logoutBtn').addEventListener('click', logoutAdmin);
document.getElementById('createTeacherBtn').addEventListener('click', createTeacherAccount);
document.getElementById('registerStudentBtn').addEventListener('click', registerStudent);
document.getElementById('saveScoreBtn')?.addEventListener('click', addStudentScore);
document.getElementById('uploadExcelBtn')?.addEventListener('click', processExcel);


// Bind custom point button
document.getElementById('saveCustomPointBtn').addEventListener('click', () => {
    const customValue = parseFloat(document.getElementById('customPointValue').value);
    processStudentPoint(customValue);
});

// Window binding parameters
window.deleteStudentScore = deleteStudentScore;
window.editStudentProfile = editStudentProfile;
window.deleteStudentProfile = deleteStudentProfile;
window.resetStudentPoints = resetStudentPoints;

async function inlineAdjustPoint(studentCode, amount) {
    try {
        const studentSnap = await getDoc(doc(db, "students", studentCode));
        if (!studentSnap.exists()) return alert("Student not found.");

        const sData = studentSnap.data();
        const targetClass = sData.studentClass || sData.Class || sData.class || 'N/A';

        await addDoc(collection(db, "student_points"), {
            studentCode: studentCode,
            studentName: sData.studentName,
            studentClass: targetClass,
            reason: "Quick Ledger Adjustment",
            points: parseFloat(amount),
            timestamp: new Date()
        });

        // Refresh the table immediately to show the new total
        loadPointsTable();
    } catch (e) {
        alert("Error adjusting points: " + e.message);
    }
}

// Bind new function to window
window.inlineAdjustPoint = inlineAdjustPoint;

// Bind event listeners for the new Class Dropdowns
document.getElementById('filterScoreClass')?.addEventListener('change', loadAdminTable);
document.getElementById('filterPointsClass')?.addEventListener('change', loadPointsTable);

// --- TAB & SUB-TAB NAVIGATION LOGIC ---
window.switchDbView = function (viewName) {
    const validViews = ['students', 'teachers', 'quizzes', 'scripting', 'all'];
    if (!validViews.includes(viewName)) viewName = 'students';

    // 1. Update Sidebar Submenu Active States
    document.querySelectorAll('.submenu-btn').forEach(btn => btn.classList.remove('active'));
    const subtabMap = {
        'students': 'subtabStudents',
        'teachers': 'subtabTeachers',
        'quizzes': 'subtabQuizzes',
        'scripting': 'subtabScripting'
    };
    if (subtabMap[viewName]) {
        const activeSubBtn = document.getElementById(subtabMap[viewName]);
        if (activeSubBtn) activeSubBtn.classList.add('active');
    }

    // 2. Show/Hide Database Section Groups
    const secStudents = document.getElementById('db-section-students');
    const secTeachers = document.getElementById('db-section-teachers');
    const secQuizzes = document.getElementById('db-section-quizzes');
    const secScripting = document.getElementById('db-section-scripting');

    if (secStudents) {
        secStudents.style.display = (viewName === 'all' || viewName === 'students') ? 'contents' : 'none';
    }
    if (secTeachers) {
        secTeachers.style.display = (viewName === 'all' || viewName === 'teachers') ? 'contents' : 'none';
    }
    if (secQuizzes) {
        secQuizzes.style.display = (viewName === 'all' || viewName === 'quizzes') ? 'contents' : 'none';
    }
    if (secScripting) {
        secScripting.style.display = (viewName === 'all' || viewName === 'scripting') ? 'contents' : 'none';
        if ((viewName === 'all' || viewName === 'scripting') && window.loadAdminDriveSettings) {
            window.loadAdminDriveSettings();
        }
    }
};

// Main Menu Button Handlers
document.querySelectorAll('.menu-btn').forEach(button => {
    button.addEventListener('click', async (e) => {
        const tabId = button.getAttribute('data-tab');
        if (!tabId) return;
        const parentGroup = button.closest('.menu-item-group');

        // Check if this is an expandable menu item
        if (button.classList.contains('menu-btn-expandable') || button.id === 'menuAdminOnly' || button.id === 'menuManageScore') {
            if (parentGroup) {
                // If it's already active and open, toggle close; otherwise open
                if (button.classList.contains('active') && parentGroup.classList.contains('open')) {
                    parentGroup.classList.toggle('open');
                } else {
                    document.querySelectorAll('.menu-item-group').forEach(grp => {
                        if (grp !== parentGroup) grp.classList.remove('open');
                    });
                    parentGroup.classList.add('open');
                }
            }
            if (parentGroup && parentGroup.id === 'groupDatabases') {
                const activeSub = parentGroup.querySelector('.submenu-btn.active');
                if (!activeSub) {
                    window.switchDbView('students');
                }
            } else if (parentGroup && parentGroup.id === 'groupManageScore') {
                const activeSub = parentGroup.querySelector('.submenu-btn.active');
                if (!activeSub) {
                    window.switchManageScoreSubtab('score-input');
                }
            }
        } else {
            // Close all dropdowns when navigating to a different main tab
            document.querySelectorAll('.menu-item-group').forEach(grp => grp.classList.remove('open'));
            document.querySelectorAll('.submenu-btn').forEach(btn => btn.classList.remove('active'));
        }

        // Remove active from all main menu buttons and hide tab contents
        document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));

        // Activate clicked button and corresponding tab
        button.classList.add('active');
        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');

        // Automatically refresh tab data on switch
        if (tabId === 'tab-manage-quizzes') {
            loadQuizzesTable();
        } else if (tabId === 'tab-manage-behavior') {
            if (typeof refreshBehaviorTabLedgers === 'function') refreshBehaviorTabLedgers();
        } else if (tabId === 'tab-manage-news') {
            loadNewsTable();
        } else if (tabId === 'tab-manage-attendance') {
            await populateAttendanceSubjects();
            await populateAttendanceClasses();
            checkAndLoadAttendance();
        } else if (tabId === 'tab-manage-scores') {
            if (typeof populateAssignmentReminderDropdowns === 'function') {
                populateAssignmentReminderDropdowns();
            }
        }
    });
});

// Sidebar Sub-menu Button Handlers (Databases -> Students, Teacher, Quiz & Manage Score -> Input, Reminder)
document.querySelectorAll('.submenu-btn').forEach(subBtn => {
    subBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabId = subBtn.getAttribute('data-tab');
        const subtab = subBtn.getAttribute('data-subtab');
        const parentGroup = subBtn.closest('.menu-item-group');

        // Keep parent group open and parent button active
        if (parentGroup) parentGroup.classList.add('open');
        document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
        const parentBtn = parentGroup?.querySelector('.menu-btn');
        if (parentBtn) parentBtn.classList.add('active');

        // Activate tab content
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');

        // Switch to the specific sub-view
        if (parentGroup && parentGroup.id === 'groupManageScore' && typeof window.switchManageScoreSubtab === 'function') {
            window.switchManageScoreSubtab(subtab);
        } else if (subtab && typeof window.switchDbView === 'function') {
            window.switchDbView(subtab);
        }

        // Trigger system load if needed
        if (typeof window.loadSystemDatabases === "function") {
            window.loadSystemDatabases();
        }
    });
});

// Close database and manage score dropdowns when clicking outside
document.addEventListener('click', (e) => {
    document.querySelectorAll('.menu-item-group').forEach(grp => {
        if (!grp.contains(e.target)) {
            grp.classList.remove('open');
        }
    });
});



// --- BULK UPLOAD TEACHERS LOGIC ---
async function processBulkTeachers() {
    const fileInput = document.getElementById('bulkTeachersFile');
    const file = fileInput.files[0];
    if (!file) return alert("Select an Excel file containing Email, Password, and Subject.");

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            let successCount = 0;
            let failCount = 0;

            for (const row of jsonData) {
                const email = String(row["Email"]).trim();
                const password = String(row["Password"]).trim();
                const subject = String(row["Subject"]).trim();

                if (email && password && subject) {
                    try {
                        const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
                        await setDoc(doc(db, "users", credential.user.uid), {
                            email: email,
                            role: "teacher",
                            subject: subject
                        });
                        await secondaryAuth.signOut();
                        successCount++;
                    } catch (authErr) {
                        console.error(`Failed to create ${email}:`, authErr);
                        failCount++;
                    }
                }
            }
            alert(`Teacher Upload Finished!\nSuccess: ${successCount}\nFailed (Skipped): ${failCount}`);
            fileInput.value = "";
        } catch (err) {
            alert("Error parsing teacher document: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}
async function resetStudentPoints(studentCode) {
    if (confirm(`Are you sure you want to reset all behavior points for student ${studentCode} to 0? This will permanently delete their point history.`)) {
        try {
            // Find all point records for this specific student
            const q = query(collection(db, "student_points"), where("studentCode", "==", studentCode));
            const snap = await getDocs(q);

            // Delete them all
            const deletePromises = [];
            snap.forEach(docSnap => {
                deletePromises.push(deleteDoc(doc(db, "student_points", docSnap.id)));
            });
            await Promise.all(deletePromises);

            alert("Points successfully reset to 0.");
            loadPointsTable(); // Refresh the ledger immediately
        } catch (e) {
            alert("Error resetting points: " + e.message);
        }
    }
}

// --- NEWS & NOTICE MANAGEMENT LOGIC ---
let currentEditNewsId = null;

window.onNewsClassCheckboxChange = function (changedInput) {
    const optionsContainer = document.getElementById('newsClassOptions');
    if (!optionsContainer) return;

    const allCb = optionsContainer.querySelector('input[value="all"]');
    const classCbs = Array.from(optionsContainer.querySelectorAll('input[type="checkbox"]:not([value="all"])'));

    if (changedInput.value === 'all') {
        if (changedInput.checked) {
            classCbs.forEach(cb => cb.checked = false);
        } else {
            const anyChecked = classCbs.some(cb => cb.checked);
            if (!anyChecked) changedInput.checked = true;
        }
    } else {
        if (changedInput.checked && allCb) {
            allCb.checked = false;
        } else {
            const anyChecked = classCbs.some(cb => cb.checked);
            if (!anyChecked && allCb) {
                allCb.checked = true;
            }
        }
    }
    updateNewsClassLabel();
};

function getSelectedNewsClasses() {
    const checkboxes = document.querySelectorAll('#newsClassOptions input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);
    if (selected.length === 0 || selected.includes('all')) return ['all'];
    return selected;
}

function updateNewsClassLabel() {
    const label = document.getElementById('newsClassLabel');
    if (!label) return;
    const selected = getSelectedNewsClasses();
    if (selected.includes('all')) {
        label.innerText = 'All Classes';
    } else if (selected.length === 1) {
        label.innerText = selected[0];
    } else {
        label.innerText = `${selected.length} Classes Selected (${selected.join(', ')})`;
    }
}
window.updateNewsClassLabel = updateNewsClassLabel;

async function populateNewsClassDropdown() {
    const optionsContainer = document.getElementById('newsClassOptions');
    if (!optionsContainer) return;

    try {
        let classesSet = new Set();
        const studentsSnap = await getDocs(collection(db, "students"));
        studentsSnap.forEach(doc => {
            const s = doc.data();
            const cls = s.studentClass || s.class;
            if (cls) classesSet.add(cls.trim());
        });

        const sortedClasses = Array.from(classesSet).filter(Boolean).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );

        const currentSelected = getSelectedNewsClasses();

        let html = `
            <label class="multi-select-option-row">
                <input type="checkbox" value="all" onchange="onNewsClassCheckboxChange(this)" ${currentSelected.includes('all') || currentSelected.length === 0 ? 'checked' : ''}>
                <strong>All Classes</strong>
            </label>
        `;

        sortedClasses.forEach(cls => {
            const isChecked = currentSelected.includes(cls) && !currentSelected.includes('all');
            html += `
                <label class="multi-select-option-row">
                    <input type="checkbox" value="${cls}" onchange="onNewsClassCheckboxChange(this)" ${isChecked ? 'checked' : ''}>
                    <span>${cls}</span>
                </label>
            `;
        });

        optionsContainer.innerHTML = html;
        updateNewsClassLabel();
    } catch (e) {
        console.error("Error populating news class dropdown:", e);
    }
}

async function addNewsUpdate() {
    const title = document.getElementById('newsTitle').value.trim();
    const content = document.getElementById('newsContent').value.trim();
    const targetClasses = getSelectedNewsClasses();
    const btn = document.getElementById('postNewsBtn');

    if (!title || !content) {
        alert("Please provide both a title and content for the notice.");
        return;
    }

    try {
        if (btn) btn.disabled = true;

        if (currentEditNewsId) {
            // Update existing notice
            await updateDoc(doc(db, "news_updates", currentEditNewsId), {
                title: title,
                content: content,
                targetClasses: targetClasses
            });
            alert("Notice updated successfully!");

            // Reset form UI
            currentEditNewsId = null;
            if (btn) {
                btn.innerText = "Post Notice";
                btn.style.background = "var(--primary-blue)";
            }
            document.getElementById('newsFormTitle').innerText = "Create a Notice";
        } else {
            // Create new notice
            await addDoc(collection(db, "news_updates"), {
                title: title,
                content: content,
                targetClasses: targetClasses,
                status: 'active', // Added status tracker
                timestamp: new Date().toISOString()
            });
            alert("News notice posted successfully!");
        }

        document.getElementById('newsTitle').value = "";
        document.getElementById('newsContent').value = "";

        // Reset class dropdown checklist to All Classes
        const optionsContainer = document.getElementById('newsClassOptions');
        if (optionsContainer) {
            optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.checked = (cb.value === 'all');
            });
            updateNewsClassLabel();
        }

        loadNewsTable();
        updateDashboardStats();
    } catch (e) {
        alert("Error saving news: " + e.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function loadNewsTable() {
    try {
        await populateNewsClassDropdown();
        const querySnapshot = await getDocs(collection(db, "news_updates"));

        const dashboardContainer = document.getElementById("dashboard-news-container");
        const manageTbody = document.querySelector("#manageNewsTable tbody");

        if (dashboardContainer) dashboardContainer.innerHTML = "";
        if (manageTbody) manageTbody.innerHTML = "";

        let newsList = [];
        querySnapshot.forEach((doc) => {
            newsList.push({ id: doc.id, ...doc.data() });
        });

        // Sort by newest first
        newsList.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        let activeCount = 0;

        newsList.forEach((news) => {
            const dateObj = new Date(news.timestamp);
            const month = dateObj.toLocaleString('default', { month: 'short' }).toUpperCase();
            const day = dateObj.getDate();
            const dateStr = dateObj.toLocaleDateString();
            const status = news.status || 'active';

            const targetArr = Array.isArray(news.targetClasses) ? news.targetClasses : ['all'];
            const targetDisplay = targetArr.includes('all') ? 'All Classes' : targetArr.join(', ');
            const encodedTarget = encodeURIComponent(JSON.stringify(targetArr));

            // Escape single and double quotes safely for inline HTML handlers
            const safeTitle = (news.title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const safeContent = (news.content || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

            // 1. Populate Manage News Table (Shows kebab menu)
            if (manageTbody) {
                const badgeBg = status === 'active' ? '#ecfdf5' : '#f1f5f9';
                const badgeText = status === 'active' ? '#10b981' : '#64748b';

                manageTbody.innerHTML += `<tr>
                    <td>${dateStr}</td>
                    <td><strong>${news.title}</strong></td>
                    <td><span style="font-size: 12px; font-weight: 600; color: var(--primary-blue);">${targetDisplay}</span></td>
                    <td><span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: ${badgeBg}; color: ${badgeText};">${status.toUpperCase()}</span></td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleMenu(event, 'news-${news.id}')">⋮</button>
                            <div id="menu-news-${news.id}" class="dropdown-menu">
                                <button class="dropdown-item" onclick="editNewsUpdate('${news.id}', '${safeTitle}', '${safeContent}', '${encodedTarget}')">Edit Notice</button>
                                <button class="dropdown-item" onclick="toggleArchiveNews('${news.id}', '${status}')">${status === 'active' ? 'Archive' : 'Unarchive'}</button>
                                <button class="dropdown-item danger" onclick="deleteNewsUpdate('${news.id}')">Delete Notice</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            }

            // 2. Populate Dashboard (Shows active notices)
            if (dashboardContainer && status === 'active' && activeCount < 3) {
                const targetTag = targetArr.includes('all') ? '' : `<span style="font-size: 10px; background: #e0e7ff; color: #4338ca; padding: 2px 6px; border-radius: 4px; font-weight: 600; margin-left: 6px;">${targetDisplay}</span>`;
                dashboardContainer.innerHTML += `
                    <div class="notice-item">
                        <div class="notice-date">${month}<br>${day}</div>
                        <div class="notice-content">
                            <h4>${news.title} ${targetTag}</h4>
                            <p>${news.content}</p>
                        </div>
                    </div>
                `;
                activeCount++;
            }
        });

        if (dashboardContainer && dashboardContainer.innerHTML === "") {
            dashboardContainer.innerHTML = "<p style='color: var(--text-gray); font-size: 13px; text-align: center; padding: 20px 0;'>No active notices at the moment.</p>";
        }

    } catch (e) {
        console.error("Error loading news: ", e);
    }
}

async function deleteNewsUpdate(docId) {
    if (confirm("Are you sure you want to permanently delete this notice?")) {
        try {
            await deleteDoc(doc(db, "news_updates", docId));
            loadNewsTable();
            updateDashboardStats();
        } catch (e) {
            alert("Error deleting notice: " + e.message);
        }
    }
}

async function toggleArchiveNews(docId, currentStatus) {
    try {
        const newStatus = currentStatus === 'active' ? 'archived' : 'active';
        await updateDoc(doc(db, "news_updates", docId), {
            status: newStatus
        });
        loadNewsTable();
    } catch (e) {
        alert("Error updating status: " + e.message);
    }
}

// Window bindings for inline HTML clicks
window.editNewsUpdate = function (id, title, content, targetClassesJson) {
    currentEditNewsId = id;
    document.getElementById('newsTitle').value = title;
    document.getElementById('newsContent').value = content;

    let targetClasses = ['all'];
    if (targetClassesJson) {
        try {
            targetClasses = JSON.parse(decodeURIComponent(targetClassesJson));
        } catch (e) {
            targetClasses = ['all'];
        }
    }

    const optionsContainer = document.getElementById('newsClassOptions');
    if (optionsContainer) {
        optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = targetClasses.includes(cb.value);
        });
        updateNewsClassLabel();
    }

    document.getElementById('newsFormTitle').innerText = "Edit Notice";
    const btn = document.getElementById('postNewsBtn');
    if (btn) {
        btn.innerText = "Update Notice";
        btn.style.background = "#f59e0b";
    }
};

window.addNewsUpdate = addNewsUpdate;
window.toggleArchiveNews = toggleArchiveNews;
window.deleteNewsUpdate = deleteNewsUpdate;

// --- QUIZ BUILDER & MANAGEMENT SYSTEM ---

// Helper: Convert Google Drive URLs
function convertDriveUrl(url) {
    if (!url) return '';
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return match && match[1] ? `https://lh3.googleusercontent.com/d/${match[1]}` : url;
}

let currentEditQuizId = null;

document.getElementById('gform-main-title')?.addEventListener('input', function (e) {
    const titleInput = document.getElementById('quizTitle');
    if (titleInput) titleInput.value = e.target.innerText || e.target.textContent || '';
});
document.getElementById('quizTitle')?.addEventListener('input', function (e) {
    const mainTitle = document.getElementById('gform-main-title');
    if (mainTitle && document.activeElement !== mainTitle) {
        mainTitle.innerText = e.target.value || '';
    }
});

// --- FLOATING RICH TEXT POPUP CONTROLLER ---
let currentEditableTarget = null;
let savedRange = null;

function saveCurrentSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        savedRange = sel.getRangeAt(0).cloneRange();
    }
}

function restoreCurrentSelection() {
    if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
    }
}

window.formatText = function (command, value = null) {
    if (!currentEditableTarget) return;

    currentEditableTarget.focus();
    restoreCurrentSelection();

    if (command === 'fontSize') {
        const px = String(value).endsWith('px') ? value : `${value}px`;
        // Use temporary size 7 to locate the newly wrapped font nodes
        document.execCommand('fontSize', false, '7');
        const fontElements = currentEditableTarget.querySelectorAll('font[size="7"]');
        fontElements.forEach(fontEl => {
            fontEl.removeAttribute('size');
            fontEl.style.fontSize = px;
        });
    } else if (command === 'fontName') {
        document.execCommand('fontName', false, value);
    } else if (command === 'bold' || command === 'italic' || command === 'underline') {
        document.execCommand(command, false, null);
    } else if (command === 'removeFormat') {
        document.execCommand('removeFormat', false, null);
        const styledEls = currentEditableTarget.querySelectorAll('[style*="font-size"], [style*="font-family"]');
        styledEls.forEach(el => {
            el.style.fontSize = '';
            el.style.fontFamily = '';
        });
    }

    saveCurrentSelection();

    // Trigger input event so any listeners (e.g. title syncing) update immediately
    currentEditableTarget.dispatchEvent(new Event('input', { bubbles: true }));
};

function showRichTextPopup(target) {
    if (!target) return;
    currentEditableTarget = target;
    saveCurrentSelection();

    const popup = document.getElementById('richTextPopupToolbar');
    if (!popup) return;

    popup.style.display = 'flex';
    positionRichTextPopup(target);
}

function positionRichTextPopup(target) {
    const popup = document.getElementById('richTextPopupToolbar');
    if (!popup || popup.style.display === 'none' || !target) return;

    const sel = window.getSelection();
    let rect = null;

    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const rangeRect = range.getBoundingClientRect();
        if (rangeRect.width > 0 || rangeRect.height > 0) {
            rect = rangeRect;
        }
    }

    if (!rect) {
        rect = target.getBoundingClientRect();
    }

    const popupRect = popup.getBoundingClientRect();

    // Center above target
    let left = rect.left + (rect.width / 2) - (popupRect.width / 2);
    left = Math.max(16, Math.min(left, window.innerWidth - popupRect.width - 16));

    let top = rect.top - popupRect.height - 8;
    // If too close to top sticky header (~60px), position below
    if (top < 65) {
        top = rect.bottom + 8;
    }

    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
}

function hideRichTextPopup() {
    const popup = document.getElementById('richTextPopupToolbar');
    if (popup) {
        popup.style.display = 'none';
    }
    currentEditableTarget = null;
    savedRange = null;
}

// Global listeners for editable text boxes inside quiz builder
document.addEventListener('focusin', function (e) {
    const target = e.target;
    if (target && target.isContentEditable && target.closest('#quiz-builder-view')) {
        showRichTextPopup(target);
    }
});

document.addEventListener('click', function (e) {
    const target = e.target;
    const popup = document.getElementById('richTextPopupToolbar');

    if (popup && (popup === target || popup.contains(target))) {
        return;
    }

    if (target && target.isContentEditable && target.closest('#quiz-builder-view')) {
        showRichTextPopup(target);
        return;
    }

    hideRichTextPopup();
});

document.addEventListener('keyup', function (e) {
    const target = e.target;
    if (target && target.isContentEditable && target.closest('#quiz-builder-view')) {
        saveCurrentSelection();
        positionRichTextPopup(target);
    }
});

document.addEventListener('mouseup', function (e) {
    const target = e.target;
    if (target && target.isContentEditable && target.closest('#quiz-builder-view')) {
        saveCurrentSelection();
        positionRichTextPopup(target);
    }
});

// Reposition on scroll and resize
window.addEventListener('scroll', function () {
    if (currentEditableTarget) positionRichTextPopup(currentEditableTarget);
}, true);

window.addEventListener('resize', function () {
    const active = document.querySelector('.gform-card.active-card');
    if (active && typeof activateCard === 'function') activateCard(active);
});

// Global card activation function for inline HTML clicks and module calls
window.activateCard = function (element) {
    if (!element) return;

    // Remove active state from all cards
    document.querySelectorAll('.gform-card').forEach(c => c.classList.remove('active-card'));

    // Add active state to selected card
    element.classList.add('active-card');

    // Move floating sidebar toolbar next to active card
    const toolbar = document.getElementById('floatingToolbar');
    const wrapper = document.querySelector('.gform-content-wrapper');
    if (toolbar && wrapper && window.innerWidth > 768) {
        const cardRect = element.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        const relativeTop = cardRect.top - wrapperRect.top;
        const topPx = Math.max(0, Math.round(relativeTop)) + 'px';
        toolbar.style.setProperty('top', topPx, 'important');
    } else if (toolbar && window.innerWidth > 768) {
        toolbar.style.setProperty('top', element.offsetTop + 'px', 'important');
    }
};

// Listen for clicks & focus anywhere inside the Quiz Builder cards
document.addEventListener('click', function (e) {
    const card = e.target.closest('.gform-card');
    const builderView = document.getElementById('quiz-builder-view');
    if (card && builderView && !builderView.classList.contains('hidden')) {
        activateCard(card);
    }
});

document.addEventListener('focusin', function (e) {
    const card = e.target.closest('.gform-card');
    const builderView = document.getElementById('quiz-builder-view');
    if (card && builderView && !builderView.classList.contains('hidden')) {
        activateCard(card);
    }
});

// Internal reference for admin.js function calls
const activateCard = window.activateCard;

// Main function to create new blocks
function addBlock(type) {
    const container = document.getElementById('quizBlocksContainer');
    if (!container) return;

    blockCounter++;
    const blockId = 'block_' + blockCounter;

    const blockDiv = document.createElement('div');
    blockDiv.className = 'gform-card quiz-block';
    blockDiv.dataset.type = type;
    blockDiv.dataset.blockId = blockId;
    blockDiv.setAttribute('onclick', 'activateCard(this)');

    blockDiv.innerHTML = getBlockInnerHtml(type, blockId);

    // If an active block exists inside quizBlocksContainer, insert right below it
    const activeBlock = document.querySelector('.quiz-block.active-card');
    if (activeBlock && activeBlock.parentNode === container) {
        activeBlock.after(blockDiv);
    } else {
        container.appendChild(blockDiv);
    }

    activateCard(blockDiv);
    return blockDiv;
}

let blockCounter = 0; // Tracks unique IDs for radio buttons

// Helper to generate the dynamic type select menu
function getTypeSelectHtml(currentType) {
    return `
        <select class="gform-type-select" onchange="switchBlockType(this)">
            <option value="mcq" ${currentType === 'mcq' ? 'selected' : ''}>Multiple Choice</option>
            <option value="fill" ${currentType === 'fill' ? 'selected' : ''}>Fill in the Blank</option>
            <option value="essay" ${currentType === 'essay' ? 'selected' : ''}>Essay / Paragraph</option>
            <option value="passage" ${currentType === 'passage' ? 'selected' : ''}>Reading Passage</option>
        </select>
    `;
}

// Generates the inner HTML template for a given block type
function getBlockInnerHtml(type, blockId) {
    const dragHandleHtml = `<div style="text-align: center; color: #94a3b8; cursor: grab; margin-top: -12px; margin-bottom: 6px; display: flex; justify-content: center;"><svg width="20" height="12" viewBox="0 0 20 12" fill="currentColor"><circle cx="4" cy="3" r="1.5"/><circle cx="10" cy="3" r="1.5"/><circle cx="16" cy="3" r="1.5"/><circle cx="4" cy="9" r="1.5"/><circle cx="10" cy="9" r="1.5"/><circle cx="16" cy="9" r="1.5"/></svg></div>`;

    const cardFooterActionsHtml = `
        <div style="display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%;">
            <button class="icon-btn duplicate" type="button" title="Duplicate Question" onclick="event.stopPropagation(); duplicateBlock(this)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            </button>
            <button class="icon-btn delete" type="button" title="Delete Block" onclick="event.stopPropagation(); deleteBlock(this)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18"></path>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            </button>
        </div>
    `;

    const mediaAndPointsHtml = `
        <div style="display: flex; gap: 10px; margin-top: 15px; margin-bottom: 15px;">
            <input type="text" class="gform-opt-input blk-img" placeholder="Optional: Google Drive Image URL" style="flex: 1; border: 1px solid #dadce0; padding: 8px; border-radius: 4px; font-size: 13px;">
            <div style="display: flex; align-items: center; gap: 8px; background: #f8fafc; padding: 0 10px; border-radius: 4px; border: 1px solid #dadce0;">
                <label style="font-size: 13px; font-weight: bold; color: #5f6368; margin: 0;">Points:</label>
                <input type="number" class="blk-points" value="1" min="0" style="width: 50px; border: none; background: transparent; font-size: 14px; text-align: center; outline: none;">
            </div>
        </div>
    `;

    if (type === 'mcq') {
        return `
            ${dragHandleHtml}
            
            <div class="gform-question-header">
                <div class="gform-q-input blk-prompt" contenteditable="true" data-placeholder="Question"></div>
                ${getTypeSelectHtml('mcq')}
            </div>
            
            ${mediaAndPointsHtml}
            
            <div class="options-container">
                ${[1, 2, 3, 4].map((num, i) => `
                    <div class="gform-opt-row">
                        <input type="radio" name="${blockId}_correct" value="${i}" onchange="this.closest('.quiz-block').querySelector('.blk-correct').value = this.value" ${i === 0 ? 'checked' : ''} title="Mark as correct answer">
                        <input type="text" class="gform-opt-input blk-opt${i}" placeholder="Option ${num}" required>
                        <button class="icon-btn delete" title="Remove Option" onclick="this.closest('.gform-opt-row').remove(); window.reindexMCQOptions(this.closest('.quiz-block'))">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                `).join('')}
            </div>
            
            <input type="hidden" class="blk-correct" value="0">
            
            <div class="gform-opt-row" style="margin-top: 8px;">
                <input type="radio" disabled>
                <span class="gform-add-opt" onclick="addOptionToMCQ(this, '${blockId}')" style="color: #1a73e8; cursor:pointer; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    Add option
                </span>
            </div>

            <div class="gform-card-footer">
                ${cardFooterActionsHtml}
            </div>
        `;
    } else if (type === 'fill') {
        return `
            ${dragHandleHtml}
            
            <div class="gform-question-header">
                <div class="gform-q-input blk-prompt" contenteditable="true" data-placeholder="Question (e.g., The capital of France is ___)"></div>
                ${getTypeSelectHtml('fill')}
            </div>
            
            ${mediaAndPointsHtml}
            
            <div style="margin-top: 15px;">
                <input type="text" class="gform-opt-input blk-answer" placeholder="Correct Answer(s) separated by commas" style="width: 100%; border: 1px solid #dadce0; padding: 10px; border-radius: 4px; box-sizing: border-box;">
                <small style="color: #70757a; display: block; margin-top: 5px;">Separate multiple acceptable variations with commas (e.g., Paris, paris)</small>
            </div>
            
            <div class="gform-card-footer">
                ${cardFooterActionsHtml}
            </div>
        `;
    } else if (type === 'essay') {
        return `
            ${dragHandleHtml}
            
            <div class="gform-question-header">
                <div class="gform-q-input blk-prompt" contenteditable="true" data-placeholder="Essay Question Prompt"></div>
                ${getTypeSelectHtml('essay')}
            </div>
            
            ${mediaAndPointsHtml}
            
            <div style="margin-top: 15px;">
                <textarea disabled placeholder="Long answer text will be written here by the student" style="width: 100%; border: 1px dotted #dadce0; padding: 10px; border-radius: 4px; background: #f8fafc; resize: none; box-sizing: border-box;"></textarea>
            </div>
            
            <div class="gform-card-footer">
                ${cardFooterActionsHtml}
            </div>
        `;
    } else if (type === 'passage') {
        return `
            ${dragHandleHtml}
            <div class="gform-question-header">
                <div class="gform-q-input blk-prompt" contenteditable="true" data-placeholder="Passage Title (e.g., Reading Comprehension: Space Exploration)" style="font-size: 18px; font-weight: 600; background: transparent; border-bottom: 2px solid #673ab7;"></div>
            </div>
            <div style="margin-top: 12px;">
                <div class="gform-desc-input blk-desc" contenteditable="true" data-placeholder="Type or paste reading passage text here..." style="min-height: 80px; font-size: 14px; line-height: 1.6; border: 1px solid #dadce0; border-radius: 6px; padding: 12px; background: #ffffff;"></div>
            </div>
            <div class="gform-card-footer">
                ${cardFooterActionsHtml}
            </div>
        `;
    } else if (type === 'header') {
        return `
            ${dragHandleHtml}
            <div class="gform-question-header">
                <div class="gform-q-input blk-prompt" contenteditable="true" data-placeholder="Header / Section Title" style="font-size: 20px; font-weight: 500; background: transparent; border-bottom: 2px solid #673ab7;"></div>
            </div>
            <div class="gform-question-header">
                <div class="gform-desc-input blk-desc" contenteditable="true" data-placeholder="Description (Optional)" style="font-size: 14px; width: 100%;"></div>
            </div>
            <div class="gform-card-footer">
                ${cardFooterActionsHtml}
            </div>
        `;
    }
}

// --- DUPLICATE & DELETE BLOCK HANDLERS ---
window.duplicateBlock = function (btnElement) {
    const sourceCard = btnElement.closest('.quiz-block');
    if (!sourceCard) return;

    blockCounter++;
    const newBlockId = 'block_' + blockCounter;
    const type = sourceCard.dataset.type || 'mcq';

    // Create cloned card element
    const clonedDiv = document.createElement('div');
    clonedDiv.className = 'gform-card quiz-block';
    clonedDiv.dataset.type = type;
    clonedDiv.dataset.blockId = newBlockId;
    clonedDiv.setAttribute('onclick', 'activateCard(this)');

    // Generate template
    clonedDiv.innerHTML = getBlockInnerHtml(type, newBlockId);

    // Copy Prompt / Title
    const srcPrompt = sourceCard.querySelector('.blk-prompt');
    const destPrompt = clonedDiv.querySelector('.blk-prompt');
    if (srcPrompt && destPrompt) {
        destPrompt.innerHTML = srcPrompt.innerHTML;
    }

    // Copy Description / Passage (if header/passage)
    const srcDesc = sourceCard.querySelector('.blk-desc');
    const destDesc = clonedDiv.querySelector('.blk-desc');
    if (srcDesc && destDesc) {
        destDesc.innerHTML = srcDesc.innerHTML;
    }

    // Copy Image URL
    const srcImg = sourceCard.querySelector('.blk-img');
    const destImg = clonedDiv.querySelector('.blk-img');
    if (srcImg && destImg) {
        destImg.value = srcImg.value;
    }

    // Copy Points
    const srcPoints = sourceCard.querySelector('.blk-points');
    const destPoints = clonedDiv.querySelector('.blk-points');
    if (srcPoints && destPoints) {
        destPoints.value = srcPoints.value;
    }

    // Copy MCQ Options & Correct Answer
    if (type === 'mcq') {
        const srcOptionRows = sourceCard.querySelectorAll('.options-container .gform-opt-row');
        const destContainer = clonedDiv.querySelector('.options-container');
        if (destContainer && srcOptionRows.length > 0) {
            destContainer.innerHTML = '';
            srcOptionRows.forEach((row, idx) => {
                const optText = row.querySelector('.gform-opt-input')?.value || '';
                const isChecked = row.querySelector('input[type="radio"]')?.checked;

                const optDiv = document.createElement('div');
                optDiv.className = 'gform-opt-row';
                optDiv.innerHTML = `
                    <input type="radio" name="${newBlockId}_correct" value="${idx}" onchange="this.closest('.quiz-block').querySelector('.blk-correct').value = this.value" ${isChecked ? 'checked' : ''} title="Mark as correct answer">
                    <input type="text" class="gform-opt-input blk-opt${idx}" placeholder="Option ${idx + 1}" value="${optText.replace(/"/g, '&quot;')}" required>
                    <button class="icon-btn delete" type="button" title="Remove Option" onclick="this.closest('.gform-opt-row').remove(); window.reindexMCQOptions(this.closest('.quiz-block'))">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                `;
                destContainer.appendChild(optDiv);
            });
        }

        const srcCorrect = sourceCard.querySelector('.blk-correct');
        const destCorrect = clonedDiv.querySelector('.blk-correct');
        if (srcCorrect && destCorrect) {
            destCorrect.value = srcCorrect.value;
        }
    } else if (type === 'fill') {
        const srcAnswer = sourceCard.querySelector('.blk-answer');
        const destAnswer = clonedDiv.querySelector('.blk-answer');
        if (srcAnswer && destAnswer) {
            destAnswer.value = srcAnswer.value;
        }
    }

    // Insert cloned block directly below the source card
    sourceCard.after(clonedDiv);

    // Activate the new block and position floating toolbar
    activateCard(clonedDiv);
    clonedDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.deleteBlock = function (btnElement) {
    const card = btnElement.closest('.gform-card');
    if (!card) return;

    const prevCard = card.previousElementSibling || card.nextElementSibling || document.querySelector('.title-card');
    card.remove();
    if (prevCard) {
        activateCard(prevCard);
    }
};

window.reindexMCQOptions = function (block) {
    if (!block) return;
    const blockId = block.dataset.blockId;
    const rows = block.querySelectorAll('.options-container .gform-opt-row');
    rows.forEach((row, idx) => {
        const radio = row.querySelector('input[type="radio"]');
        if (radio) {
            radio.name = `${blockId}_correct`;
            radio.value = idx;
        }
        const input = row.querySelector('.gform-opt-input');
        if (input) {
            input.placeholder = `Option ${idx + 1}`;
            input.className = `gform-opt-input blk-opt${idx}`;
        }
    });
};

// Function triggered when changing the dropdown option on a card
window.switchBlockType = function (selectElement) {
    const newType = selectElement.value;
    const blockDiv = selectElement.closest('.quiz-block');
    if (!blockDiv) return;

    // Save current user-typed values before switching layout
    const promptNode = blockDiv.querySelector('.blk-prompt');
    const savedPrompt = promptNode ? promptNode.innerText : '';

    const imgNode = blockDiv.querySelector('.blk-img');
    const savedImg = imgNode ? imgNode.value : '';

    const pointsNode = blockDiv.querySelector('.blk-points');
    const savedPoints = pointsNode ? pointsNode.value : '1';

    let blockId = blockDiv.dataset.blockId;
    if (!blockId) {
        blockCounter++;
        blockId = 'block_' + blockCounter;
        blockDiv.dataset.blockId = blockId;
    }

    // Update block type metadata
    blockDiv.dataset.type = newType;

    // Re-render block internal HTML
    blockDiv.innerHTML = getBlockInnerHtml(newType, blockId);

    // Restore saved question text, image URL, and points
    const newPromptNode = blockDiv.querySelector('.blk-prompt');
    if (newPromptNode) newPromptNode.innerText = savedPrompt;

    const newImgNode = blockDiv.querySelector('.blk-img');
    if (newImgNode) newImgNode.value = savedImg;

    const newPointsNode = blockDiv.querySelector('.blk-points');
    if (newPointsNode) newPointsNode.value = savedPoints;

    // Re-attach rich text toolbar
    activateCard(blockDiv);
};



// --- Quiz UI Toggles (Landing vs Builder) ---
window.openQuizBuilder = function (isNew = true) {
    document.getElementById('quiz-landing-view').classList.add('hidden');
    document.getElementById('quiz-builder-view').classList.remove('hidden');

    if (isNew) {
        currentEditQuizId = null;
        document.getElementById('quizTitle').value = "Untitled Quiz";
        setQuizClasses([]);
        document.getElementById('quizSubject').value = "";
        document.getElementById('quizBlocksContainer').innerHTML = "";
        addBlock('mcq');

        const mainTitle = document.getElementById('gform-main-title');
        if (mainTitle) mainTitle.innerText = "Untitled Quiz";

        const quizTypeSelect = document.getElementById('quizTypeSelect');
        if (quizTypeSelect) quizTypeSelect.value = "Quiz";

        const saveBtn = document.getElementById('saveQuizBtn');
        if (saveBtn) {
            saveBtn.innerText = "Publish";
        }

        // Initialize toolbar position
        const titleCard = document.querySelector('.title-card');
        if (titleCard) activateCard(titleCard);
    }
}

window.closeQuizBuilder = function () {
    hideRichTextPopup();
    document.getElementById('quiz-builder-view').classList.add('hidden');
    document.getElementById('quiz-landing-view').classList.remove('hidden');
    loadQuizzesTable(); // Refresh the table when going back
}

// Dynamically update the header title as you type the quiz name
document.getElementById('quizTitle')?.addEventListener('input', function (e) {
    const display = document.getElementById('displayQuizTitle');
    if (display) {
        display.innerText = e.target.value || "New Untitled Quiz";
    }
});

window.addBlock = addBlock;

// --- 2. UPDATED QUIZ TABLE RENDERING WITH STATUS BADGE & MENU ---
// --- TOGGLE QUIZ STATUS (ACTIVE / DEACTIVE) ---
async function toggleQuizStatus(id, currentStatus) {
    try {
        const newStatus = currentStatus === 'active' ? 'deactive' : 'active';
        await updateDoc(doc(db, "quizzes", id), {
            status: newStatus
        });
        loadQuizzesTable();
    } catch (e) {
        alert("Error toggling quiz status: " + e.message);
    }
}
window.toggleQuizStatus = toggleQuizStatus;

// --- LOAD QUIZZES TABLE (ACTIVE & PAST QUIZZES WITH DELETION) ---
async function loadQuizzesTable() {
    const tbody = document.querySelector("#quizTable tbody");
    const pastTbody = document.querySelector("#pastQuizTable tbody");
    const pastBadge = document.getElementById("pastQuizBadgeCount");
    if (!tbody) return;

    try {
        const snap = await getDocs(collection(db, "quizzes"));
        tbody.innerHTML = "";

        const quizzesList = [];
        const activeTitlesSet = new Set();

        snap.forEach(docSnap => {
            const data = docSnap.data();
            quizzesList.push({ id: docSnap.id, ...data });
            if (data.title) {
                activeTitlesSet.add(data.title.trim().toLowerCase());
            }
        });

        // Sort quizzes by creation/update date descending, or by title
        quizzesList.sort((a, b) => {
            const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
            const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
            if (timeB !== timeA) return timeB - timeA;
            return (a.title || '').localeCompare(b.title || '');
        });

        if (quizzesList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-gray); padding: 30px;">No created quizzes found. Click <strong>&quot;+ Create New Quiz&quot;</strong> above to create one.</td></tr>`;
        } else {
            quizzesList.forEach(quiz => {
                const safeTitle = (quiz.title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                const displayTitle = escapeHtml(quiz.title || 'Untitled Quiz');
                const displaySubject = escapeHtml(quiz.subject || '-');
                const displayClass = escapeHtml(quiz.targetClass || '-');
                const status = quiz.status || 'active';

                const badgeBg = status === 'active' ? '#ecfdf5' : '#f1f5f9';
                const badgeText = status === 'active' ? '#10b981' : '#64748b';
                const toggleLabel = status === 'active' ? 'Deactivate Quiz' : 'Activate Quiz';

                tbody.innerHTML += `<tr>
                    <td><strong>${displayTitle}</strong></td>
                    <td>${displaySubject}</td>
                    <td>${displayClass}</td>
                    <td>
                        <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: ${badgeBg}; color: ${badgeText};">
                            ${status.toUpperCase()}
                        </span>
                    </td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleMenu(event, 'quiz-${quiz.id}')">⋮</button>
                            <div id="menu-quiz-${quiz.id}" class="dropdown-menu">
                                <button class="dropdown-item" onclick="viewQuizResults('${safeTitle}', '${quiz.id}')">View Results</button>
                                <button class="dropdown-item" onclick="toggleQuizStatus('${quiz.id}', '${status}')">${toggleLabel}</button>
                                <button class="dropdown-item" onclick="editQuiz('${quiz.id}')">Edit Quiz</button>
                                <button class="dropdown-item danger" onclick="deleteQuiz('${quiz.id}', '${safeTitle}')">Delete Quiz</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            });
        }

        // Load Past Quizzes & Completed Assessments from quiz_results
        if (pastTbody) {
            pastTbody.innerHTML = "";
            const pastQuizzesMap = new Map();

            try {
                const resultsSnap = await getDocs(collection(db, "quiz_results"));
                resultsSnap.forEach(docSnap => {
                    const r = docSnap.data();
                    const rawTitle = (r.quizTitle || 'Untitled Quiz').trim();
                    const titleLower = rawTitle.toLowerCase();

                    // If it is not in the active quizzes collection, treat as Past Quiz
                    if (!activeTitlesSet.has(titleLower)) {
                        if (!pastQuizzesMap.has(titleLower)) {
                            pastQuizzesMap.set(titleLower, {
                                title: rawTitle,
                                subject: r.subject || 'General',
                                submissionCount: 0,
                                lastSubmitted: r.submittedAt || null,
                                docIds: []
                            });
                        }
                        const item = pastQuizzesMap.get(titleLower);
                        item.submissionCount++;
                        item.docIds.push(docSnap.id);
                        if (r.submittedAt && (!item.lastSubmitted || new Date(r.submittedAt) > new Date(item.lastSubmitted))) {
                            item.lastSubmitted = r.submittedAt;
                        }
                        if (r.subject && r.subject !== 'General' && item.subject === 'General') {
                            item.subject = r.subject;
                        }
                    }
                });
            } catch (err) {
                console.warn("Error querying quiz_results for past quizzes:", err);
            }

            const pastQuizzesList = Array.from(pastQuizzesMap.values());
            // Sort by most recent submission or title
            pastQuizzesList.sort((a, b) => {
                const tA = a.lastSubmitted ? new Date(a.lastSubmitted).getTime() : 0;
                const tB = b.lastSubmitted ? new Date(b.lastSubmitted).getTime() : 0;
                if (tB !== tA) return tB - tA;
                return a.title.localeCompare(b.title);
            });

            if (pastBadge) pastBadge.innerText = pastQuizzesList.length;

            if (pastQuizzesList.length === 0) {
                pastTbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-gray); padding: 24px;">No past or archived quizzes found in student records.</td></tr>`;
            } else {
                pastQuizzesList.forEach((quiz, idx) => {
                    const safeTitle = quiz.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    const displayTitle = escapeHtml(quiz.title);
                    const displaySubject = escapeHtml(quiz.subject);
                    const displayCount = `${quiz.submissionCount} submission${quiz.submissionCount === 1 ? '' : 's'}`;

                    pastTbody.innerHTML += `<tr>
                        <td><strong>${displayTitle}</strong></td>
                        <td>${displaySubject}</td>
                        <td><span style="font-weight: 600; color: #1e5eff;">${displayCount}</span></td>
                        <td>
                            <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: #fef3c7; color: #d97706;">
                                PAST QUIZ
                            </span>
                        </td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <button 
                                    type="button" 
                                    class="icon-btn" 
                                    style="padding: 6px 12px; background: rgba(30, 94, 255, 0.08); color: #1e5eff; border: 1px solid rgba(30, 94, 255, 0.2); border-radius: 6px; font-size: 12.5px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"
                                    onclick="viewQuizResults('${safeTitle}')"
                                    title="View student results"
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                    <span>Results</span>
                                </button>
                                <button 
                                    type="button" 
                                    class="icon-btn delete" 
                                    style="padding: 6px 12px; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 6px; font-size: 12.5px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"
                                    onclick="deletePastQuiz('${safeTitle}')"
                                    title="Permanently delete this quiz and its student scores"
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </td>
                    </tr>`;
                });
            }
        }

    } catch (e) {
        console.error("Error loading quizzes:", e);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 20px;">Failed to load quizzes: ${escapeHtml(e.message)}</td></tr>`;
        }
    }
}
window.loadQuizzesTable = loadQuizzesTable;


// --- UPDATED EDIT QUIZ ---
async function editQuiz(id) {
    try {
        const snap = await getDoc(doc(db, "quizzes", id));
        if (!snap.exists()) return alert("Quiz missing.");
        const quiz = snap.data();

        openQuizBuilder(false);

        const displayQuizTitle = document.getElementById('displayQuizTitle');
        if (displayQuizTitle) displayQuizTitle.innerText = quiz.title || "Untitled";

        const mainTitle = document.getElementById('gform-main-title');
        if (mainTitle) mainTitle.innerText = quiz.title || "Untitled";

        currentEditQuizId = id;
        document.getElementById('quizTitle').value = quiz.title || "";

        let quizClasses = [];
        if (Array.isArray(quiz.targetClassesList) && quiz.targetClassesList.length > 0) {
            quizClasses = quiz.targetClassesList;
        } else if (quiz.targetClass) {
            quizClasses = quiz.targetClass.split(',').map(s => s.trim()).filter(Boolean);
        }
        setQuizClasses(quizClasses);
        document.getElementById('quizSubject').value = quiz.subject || "";
        if (document.getElementById('quizTypeSelect')) {
            document.getElementById('quizTypeSelect').value = quiz.type || "Quiz";
        }

        const container = document.getElementById('quizBlocksContainer');
        container.innerHTML = "";

        (quiz.items || quiz.questions || []).forEach((item, index) => {
            const type = item.type || 'mcq';
            const block = addBlock(type); // addBlock now returns the block element

            if (type === 'header') {
                const promptNode = block.querySelector('.blk-prompt');
                const descNode = block.querySelector('.blk-desc');
                if (promptNode) promptNode.innerText = item.text || '';
                if (descNode) descNode.innerText = item.description || '';

            } else if (type === 'mcq') {
                const promptNode = block.querySelector('.blk-prompt');
                if (promptNode) promptNode.innerText = item.prompt || item.question || '';
                if (block.querySelector('.blk-img')) block.querySelector('.blk-img').value = item.imageUrl || '';
                if (block.querySelector('.blk-points')) block.querySelector('.blk-points').value = item.points || 1;

                // Clear the default options and rebuild based on saved data
                const optionsContainer = block.querySelector('.options-container');
                if (optionsContainer) {
                    optionsContainer.innerHTML = '';
                    (item.options || []).forEach((optText, i) => {
                        const newRow = document.createElement('div');
                        newRow.className = 'gform-opt-row';
                        const isChecked = item.correct == i ? 'checked' : '';
                        newRow.innerHTML = `
                            <input type="radio" name="edit_block_${index}_correct" value="${i}" onchange="this.closest('.quiz-block').querySelector('.blk-correct').value = this.value" ${isChecked}>
                            <input type="text" class="gform-opt-input" value="${optText}" required>
                            <button class="icon-btn delete" title="Remove Option" onclick="this.closest('.gform-opt-row').remove()">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        `;
                        optionsContainer.appendChild(newRow);
                    });
                }
                if (block.querySelector('.blk-correct')) block.querySelector('.blk-correct').value = item.correct ?? 0;

            } else if (type === 'fill') {
                const promptNode = block.querySelector('.blk-prompt');
                if (promptNode) promptNode.innerText = item.prompt || '';
                if (block.querySelector('.blk-img')) block.querySelector('.blk-img').value = item.imageUrl || '';
                if (block.querySelector('.blk-points')) block.querySelector('.blk-points').value = item.points || 1;
                if (item.answers && block.querySelector('.blk-answer')) block.querySelector('.blk-answer').value = item.answers.join(', ');

            } else if (type === 'essay') {
                const promptNode = block.querySelector('.blk-prompt');
                if (promptNode) promptNode.innerText = item.prompt || '';
                if (block.querySelector('.blk-img')) block.querySelector('.blk-img').value = item.imageUrl || '';
                if (block.querySelector('.blk-points')) block.querySelector('.blk-points').value = item.points || 1;
            }
        });

        const saveBtn = document.getElementById('saveQuizBtn');
        if (saveBtn) {
            saveBtn.innerText = "Update Quiz";
            saveBtn.style.background = "#ffc107";
        }
        document.getElementById('quizTitle').scrollIntoView({ behavior: 'smooth' });
    } catch (e) { alert("Error loading quiz: " + e.message); }
}


// 5. Delete Quiz (Cascades to student quiz_results and exam scores)
async function deleteQuiz(id, title = '') {
    let resolvedTitle = title;
    if (!resolvedTitle && id) {
        try {
            const s = await getDoc(doc(db, "quizzes", id));
            if (s.exists()) resolvedTitle = s.data().title || '';
        } catch (e) {}
    }

    const titleMsg = resolvedTitle ? ` "${resolvedTitle}"` : '';
    if (!confirm(`Are you sure you want to delete this quiz${titleMsg}?\n\nThis will also permanently delete all related student submissions, scores, and records from the database.`)) {
        return;
    }

    try {
        let deletedSubmissions = 0;
        const deletePromises = [];

        // 1. Delete quiz doc from quizzes collection
        if (id) {
            deletePromises.push(deleteDoc(doc(db, "quizzes", id)));
        }

        // 2. Cascade delete from quiz_results by quizId and by quizTitle
        const normTitle = (resolvedTitle || '').trim().toLowerCase();
        try {
            const resSnap = await getDocs(collection(db, "quiz_results"));
            resSnap.forEach(d => {
                const data = d.data();
                const rTitle = (data.quizTitle || '').trim().toLowerCase();
                if ((id && data.quizId === id) || (normTitle && rTitle === normTitle)) {
                    deletedSubmissions++;
                    deletePromises.push(deleteDoc(doc(db, "quiz_results", d.id)));
                }
            });
        } catch (e) {
            console.warn("Could not query quiz_results for deletion:", e);
        }

        // 3. Clean up legacy or matching exam_scores & scores
        if (normTitle) {
            try {
                const examSnap = await getDocs(collection(db, "exam_scores"));
                examSnap.forEach(d => {
                    const data = d.data();
                    const eName = (data.examName || data.title || '').trim().toLowerCase();
                    if (eName === normTitle) {
                        deletePromises.push(deleteDoc(doc(db, "exam_scores", d.id)));
                    }
                });
            } catch (e) {}

            try {
                const scoresSnap = await getDocs(collection(db, "scores"));
                scoresSnap.forEach(d => {
                    const data = d.data();
                    const sName = (data.examName || data.title || '').trim().toLowerCase();
                    if (sName === normTitle) {
                        deletePromises.push(deleteDoc(doc(db, "scores", d.id)));
                    }
                });
            } catch (e) {}
        }

        await Promise.all(deletePromises);
        alert(`Quiz${titleMsg} and all ${deletedSubmissions} student submission(s) have been permanently deleted!`);
        loadQuizzesTable();
    } catch (e) {
        console.error("Error deleting quiz:", e);
        alert("Error deleting quiz: " + e.message);
    }
}
window.deleteQuiz = deleteQuiz;

// 6. Delete Past Quiz (Clears quiz_results, exam_scores, and quizzes by title)
async function deletePastQuiz(quizTitle) {
    if (!quizTitle) return;
    const confirmed = confirm(`Are you sure you want to permanently delete the past quiz "${quizTitle}"?\n\nThis will permanently remove the quiz and ALL related student submissions, scores, and records from the database.`);
    if (!confirmed) return;

    try {
        let deletedCount = 0;
        const deletePromises = [];
        const normTitle = quizTitle.trim().toLowerCase();

        // 1. Delete matching submissions from quiz_results
        try {
            const resSnap = await getDocs(collection(db, "quiz_results"));
            resSnap.forEach(d => {
                const data = d.data();
                const rTitle = (data.quizTitle || '').trim().toLowerCase();
                if (rTitle === normTitle || data.quizTitle === quizTitle) {
                    deletedCount++;
                    deletePromises.push(deleteDoc(doc(db, "quiz_results", d.id)));
                }
            });
        } catch (e) {
            console.warn("Error querying quiz_results for past quiz deletion:", e);
        }

        // 2. Also check and delete from quizzes if document exists
        try {
            const qQuizzes = await getDocs(collection(db, "quizzes"));
            qQuizzes.forEach(d => {
                const data = d.data();
                const qTitle = (data.title || '').trim().toLowerCase();
                if (qTitle === normTitle || data.title === quizTitle) {
                    deletePromises.push(deleteDoc(doc(db, "quizzes", d.id)));
                }
            });
        } catch (e) {}

        // 3. Clean up exam_scores and scores
        try {
            const examSnap = await getDocs(collection(db, "exam_scores"));
            examSnap.forEach(d => {
                const data = d.data();
                const eName = (data.examName || data.title || '').trim().toLowerCase();
                if (eName === normTitle) {
                    deletePromises.push(deleteDoc(doc(db, "exam_scores", d.id)));
                }
            });
        } catch (e) {}

        try {
            const scoresSnap = await getDocs(collection(db, "scores"));
            scoresSnap.forEach(d => {
                const data = d.data();
                const sName = (data.examName || data.title || '').trim().toLowerCase();
                if (sName === normTitle) {
                    deletePromises.push(deleteDoc(doc(db, "scores", d.id)));
                }
            });
        } catch (e) {}

        await Promise.all(deletePromises);

        alert(`Successfully deleted "${quizTitle}" and all ${deletedCount} related student score record(s) from the database.`);
        loadQuizzesTable();
    } catch (err) {
        console.error("Error deleting past quiz:", err);
        alert("Error deleting past quiz: " + err.message);
    }
}
window.deletePastQuiz = deletePastQuiz;

// --- QUIZ RESULTS & SCORE SUBMISSION (RESPONSIVE CLASS FILTERING & STATUS ICONS) ---
window.quizResultsCurrentState = {
    quizTitle: '',
    quizId: '',
    quizData: null,
    eligibleStudents: [],
    submissionsMap: {},
    scoresMap: {},
    distinctClasses: [],
    selectedClass: 'all',
    statusFilter: 'all',
    searchKeyword: ''
};

window.viewQuizResults = async function (quizTitle, quizId = null) {
    const modal = document.getElementById("quizResultsModal");
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.style.display = "flex";

    const tbody = modal.querySelector("#quizResultsTable tbody");
    const modalTitle = modal.querySelector("#quizResultsTitle");
    const subjectTag = modal.querySelector("#quizResultsSubjectTag");
    const targetTag = modal.querySelector("#quizResultsTargetTag");
    const pillsContainer = modal.querySelector("#quizClassPillsContainer");
    const searchInput = modal.querySelector("#quizStudentSearchInput");

    if (searchInput) searchInput.value = "";
    if (modalTitle) modalTitle.innerText = quizTitle || "Quiz Submissions";
    if (subjectTag) subjectTag.innerText = "Loading...";
    if (targetTag) targetTag.innerText = "Assigned: Loading...";
    if (pillsContainer) pillsContainer.innerHTML = `<span style="font-size:12px; color:#64748b;">Loading classes...</span>`;
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px; color:#64748b;">Loading class rosters and submissions...</td></tr>`;

    try {
        // 1. Fetch Quiz Info to get Assigned Classes
        let quizData = null;
        if (quizId) {
            try {
                const qSnap = await getDoc(doc(db, "quizzes", quizId));
                if (qSnap.exists()) quizData = qSnap.data();
            } catch (e) {
                console.warn("Could not fetch quiz by id:", e);
            }
        }
        if (!quizData) {
            const qQuery = query(collection(db, "quizzes"), where("title", "==", quizTitle));
            const qQuerySnap = await getDocs(qQuery);
            if (!qQuerySnap.empty) {
                quizData = qQuerySnap.docs[0].data();
            }
        }

        const subject = quizData?.subject || "General";
        if (subjectTag) subjectTag.innerText = subject;

        // Parse Assigned Classes
        let isAllClasses = false;
        let assignedClasses = [];

        if (Array.isArray(quizData?.targetClassesList) && quizData.targetClassesList.length > 0) {
            if (quizData.targetClassesList.some(c => c.toLowerCase() === 'all' || c.toLowerCase() === 'all classes')) {
                isAllClasses = true;
            } else {
                assignedClasses = quizData.targetClassesList.map(c => c.trim()).filter(Boolean);
            }
        } else if (quizData?.targetClass) {
            if (quizData.targetClass.toLowerCase().includes('all class') || quizData.targetClass.toLowerCase() === 'all') {
                isAllClasses = true;
            } else {
                assignedClasses = quizData.targetClass.split(',').map(c => c.trim()).filter(Boolean);
            }
        } else {
            isAllClasses = true;
        }

        if (targetTag) {
            targetTag.innerText = isAllClasses ? "Assigned: All Classes" : `Assigned: ${assignedClasses.join(', ')}`;
        }

        // 2. Fetch all students from Firestore
        const studentsSnap = await getDocs(collection(db, "students"));
        let eligibleStudents = [];

        studentsSnap.forEach(docSnap => {
            const sData = docSnap.data();
            const sClass = (sData.studentClass || sData.class || sData.Class || 'N/A').trim();
            const sCode = sData.code || docSnap.id;
            const sName = sData.studentName || sData.name || 'Unknown Student';

            if (isAllClasses) {
                eligibleStudents.push({ id: docSnap.id, code: sCode, studentName: sName, studentClass: sClass });
            } else {
                const match = assignedClasses.some(c => c.toLowerCase() === sClass.toLowerCase());
                if (match) {
                    eligibleStudents.push({ id: docSnap.id, code: sCode, studentName: sName, studentClass: sClass });
                }
            }
        });

        // Sort students: by class then by name (A-Z)
        eligibleStudents.sort((a, b) => {
            const classComp = a.studentClass.localeCompare(b.studentClass, undefined, { numeric: true });
            if (classComp !== 0) return classComp;
            return a.studentName.localeCompare(b.studentName);
        });

        // 3. Fetch Quiz Submissions (quiz_results)
        const submissionsMap = {};
        try {
            const qResults = query(collection(db, "quiz_results"), where("quizTitle", "==", quizTitle));
            const subSnap = await getDocs(qResults);
            subSnap.forEach(docSnap => {
                const data = docSnap.data();
                const sCode = (data.studentCode || '').toString().trim().toLowerCase();
                const sName = (data.studentName || '').toString().trim().toLowerCase();
                if (sCode) {
                    submissionsMap[sCode] = { id: docSnap.id, ...data };
                }
                if (sName) {
                    submissionsMap[`name_${sName}`] = { id: docSnap.id, ...data };
                }
            });
        } catch (err) {
            console.warn("Error fetching quiz_results:", err);
        }

        // 4. Fetch Saved Scores (from unified exam_scores and legacy scores)
        const scoresMap = {};
        try {
            // Query unified exam_scores by examName and quizName
            const examScoresQuery = query(collection(db, "exam_scores"), where("examName", "==", quizTitle));
            const examScoresSnap = await getDocs(examScoresQuery);
            examScoresSnap.forEach(docSnap => {
                const data = docSnap.data();
                const code = (data.studentCode || '').toString().trim().toLowerCase();
                const name = (data.studentName || '').toString().trim().toLowerCase();
                if (code) scoresMap[code] = data.score;
                if (name) scoresMap[`name_${name}`] = data.score;
            });

            const quizNameQuery = query(collection(db, "exam_scores"), where("quizName", "==", quizTitle));
            const quizNameSnap = await getDocs(quizNameQuery);
            quizNameSnap.forEach(docSnap => {
                const data = docSnap.data();
                const code = (data.studentCode || '').toString().trim().toLowerCase();
                const name = (data.studentName || '').toString().trim().toLowerCase();
                if (code && scoresMap[code] === undefined) scoresMap[code] = data.score;
                if (name && scoresMap[`name_${name}`] === undefined) scoresMap[`name_${name}`] = data.score;
            });

            // Also check legacy scores collection
            const scoresQuery = query(collection(db, "scores"), where("quizTitle", "==", quizTitle));
            const scoresSnap = await getDocs(scoresQuery);
            scoresSnap.forEach(docSnap => {
                const data = docSnap.data();
                const code = (data.studentCode || docSnap.id || '').toString().trim().toLowerCase();
                const name = (data.studentName || '').toString().trim().toLowerCase();
                if (code && scoresMap[code] === undefined) {
                    scoresMap[code] = data.score;
                }
                if (name && scoresMap[`name_${name}`] === undefined) {
                    scoresMap[`name_${name}`] = data.score;
                }
            });
        } catch (err) {
            console.warn("Error fetching scores:", err);
        }

        // 5. Build Distinct Classes List directly from eligible students
        let distinctClasses = [];
        if (isAllClasses) {
            distinctClasses = [...new Set(eligibleStudents.map(s => s.studentClass))].filter(c => c && c !== 'N/A').sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        } else {
            const studentClassesSet = new Set(eligibleStudents.map(s => (s.studentClass || '').toLowerCase().trim()));
            distinctClasses = assignedClasses.filter(c => studentClassesSet.has(c.toLowerCase().trim()));
            if (distinctClasses.length === 0) {
                distinctClasses = [...new Set(eligibleStudents.map(s => s.studentClass))].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            }
        }

        // 6. Save in Global State
        window.quizResultsCurrentState = {
            quizTitle,
            quizId,
            quizData,
            eligibleStudents,
            submissionsMap,
            scoresMap,
            distinctClasses,
            selectedClass: 'all',
            statusFilter: 'all',
            searchKeyword: ''
        };

        // 7. Render Class Selection Pills
        renderQuizClassPills();

        // 8. Render Results Table
        renderQuizResultsTable();

    } catch (error) {
        console.error("Error loading quiz results:", error);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: #ef4444; padding: 20px;">Error loading data: ${error.message}</td></tr>`;
    }
};

function renderQuizClassPills() {
    const state = window.quizResultsCurrentState;
    const container = document.getElementById("quizClassPillsContainer");
    if (!container) return;

    const normalize = (str) => (str || '').toString().trim().toLowerCase();
    const totalCount = state.eligibleStudents.length;

    let html = `
        <button type="button" 
            data-class="all"
            class="quiz-class-pill ${state.selectedClass === 'all' ? 'active' : ''}" 
            onclick="window.setQuizClassFilter('all', this)">
            All (${totalCount})
        </button>
    `;

    state.distinctClasses.forEach(cls => {
        const countInCls = state.eligibleStudents.filter(s => normalize(s.studentClass) === normalize(cls)).length;
        const isActive = normalize(state.selectedClass) === normalize(cls);
        html += `
            <button type="button" 
                data-class="${escapeHtml(cls)}"
                class="quiz-class-pill ${isActive ? 'active' : ''}" 
                onclick="window.setQuizClassFilter('${cls.replace(/'/g, "\\'")}', this)">
                ${escapeHtml(cls)} (${countInCls})
            </button>
        `;
    });

    container.innerHTML = html;
}

window.setQuizClassFilter = function (cls, btn = null) {
    window.quizResultsCurrentState.selectedClass = cls;
    
    const container = document.getElementById("quizClassPillsContainer");
    if (container) {
        const normalize = (str) => (str || '').toString().trim().toLowerCase();
        container.querySelectorAll(".quiz-class-pill").forEach(p => {
            const pClass = p.getAttribute("data-class");
            const isMatch = normalize(pClass) === normalize(cls);
            p.classList.toggle("active", isMatch);
        });
    }

    renderQuizResultsTable();
};

window.setQuizStatusFilter = function (status, btn = null) {
    window.quizResultsCurrentState.statusFilter = status;

    const buttons = document.querySelectorAll(".quiz-status-filter-btn");
    buttons.forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-filter") === status);
    });

    renderQuizResultsTable();
};

window.filterQuizResults = function () {
    const searchInput = document.getElementById("quizStudentSearchInput");
    window.quizResultsCurrentState.searchKeyword = searchInput ? searchInput.value.trim().toLowerCase() : "";
    renderQuizResultsTable();
};

function renderQuizResultsTable() {
    const state = window.quizResultsCurrentState;
    const tbody = document.querySelector("#quizResultsTable tbody");
    if (!tbody) return;

    const normalize = (str) => (str || '').toString().trim().toLowerCase();

    // 1. Filter by selected class first
    const inClassStudents = state.eligibleStudents.filter(s => {
        if (state.selectedClass === 'all') return true;
        return normalize(s.studentClass) === normalize(state.selectedClass);
    });

    const inClassTotal = inClassStudents.length;
    let inClassDone = 0;

    inClassStudents.forEach(s => {
        const normCode = normalize(s.code);
        const normId = normalize(s.id);
        const normName = normalize(s.studentName);
        const subData = state.submissionsMap[normCode] || state.submissionsMap[normId] || state.submissionsMap[`name_${normName}`];
        const savedScore = state.scoresMap[normCode] ?? state.scoresMap[normId] ?? state.scoresMap[`name_${normName}`];
        const isDone = !!subData || (savedScore !== "" && savedScore !== undefined && savedScore !== null);
        if (isDone) inClassDone++;
    });

    const inClassPending = inClassTotal - inClassDone;

    // Update Stats in Toolbar
    const totalEl = document.getElementById("statsTotalCount");
    const doneEl = document.getElementById("statsDoneCount");
    const pendingEl = document.getElementById("statsPendingCount");

    if (totalEl) totalEl.innerText = inClassTotal;
    if (doneEl) doneEl.innerText = inClassDone;
    if (pendingEl) pendingEl.innerText = inClassPending;

    // 2. Filter students by status and search keyword
    let filtered = inClassStudents.filter(s => {
        const normCode = normalize(s.code);
        const normId = normalize(s.id);
        const normName = normalize(s.studentName);
        const subData = state.submissionsMap[normCode] || state.submissionsMap[normId] || state.submissionsMap[`name_${normName}`];
        const savedScore = state.scoresMap[normCode] ?? state.scoresMap[normId] ?? state.scoresMap[`name_${normName}`];
        const isDone = !!subData || (savedScore !== "" && savedScore !== undefined && savedScore !== null);

        // Status filter
        if (state.statusFilter === 'done' && !isDone) return false;
        if (state.statusFilter === 'pending' && isDone) return false;

        // Search filter
        if (state.searchKeyword) {
            const kw = state.searchKeyword;
            const matchName = normName.includes(kw);
            const matchCode = normCode.includes(kw) || normId.includes(kw);
            const matchClass = normalize(s.studentClass).includes(kw);
            if (!matchName && !matchCode && !matchClass) return false;
        }

        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align:center; padding: 36px 16px; color: #64748b;">
                    <div style="margin-bottom: 10px; display: flex; justify-content: center;">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                        </svg>
                    </div>
                    <div style="font-weight: 600; font-size: 14px; color: var(--text-dark, #334155);">No students match your filter</div>
                    <div style="font-size: 12px; margin-top: 4px;">Try selecting another class tab or adjusting the search filter.</div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = "";

    filtered.forEach(student => {
        const studentCode = student.code || student.id;
        const studentName = student.studentName;
        const studentClass = student.studentClass;
        
        const normCode = normalize(student.code);
        const normId = normalize(student.id);
        const normName = normalize(student.studentName);

        const subData = state.submissionsMap[normCode] || state.submissionsMap[normId] || state.submissionsMap[`name_${normName}`];
        const isSubmittedOnline = !!subData;

        const savedScore = state.scoresMap[normCode] ?? state.scoresMap[normId] ?? state.scoresMap[`name_${normName}`] ?? "";
        const hasOfficialScore = savedScore !== "" && savedScore !== undefined && savedScore !== null;

        // Status Badge HTML with visual icon
        let statusBadgeHtml = "";
        if (isSubmittedOnline) {
            const autoScoreTxt = (subData.totalAutoGradable && subData.totalAutoGradable > 0) 
                ? `<small style="display:block; font-size:11px; color:#047857; font-weight:600; margin-top:2px;">Auto: ${subData.score ?? 0}/${subData.totalAutoGradable} pts</small>` 
                : '';
            
            statusBadgeHtml = `
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <span class="quiz-badge-status-done" title="Submitted Online">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        Done
                    </span>
                    ${autoScoreTxt}
                </div>
            `;
        } else if (hasOfficialScore) {
            statusBadgeHtml = `
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <span class="quiz-badge-status-done" style="background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe;" title="Graded Offline">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        Graded
                    </span>
                    <small style="display:block; font-size:11px; color:#64748b; margin-top:2px;">Offline Score</small>
                </div>
            `;
        } else {
            statusBadgeHtml = `
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <span class="quiz-badge-status-pending" title="Not submitted yet">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        Not Done
                    </span>
                    <small style="display:block; font-size:11px; color:#94a3b8; margin-top:2px;">Unsubmitted</small>
                </div>
            `;
        }

        const safeStudentName = studentName.replace(/'/g, "\\'");
        const safeStudentClass = studentClass.replace(/'/g, "\\'");
        const safeQuizTitle = state.quizTitle.replace(/'/g, "\\'");

        tbody.innerHTML += `
            <tr style="border-bottom: 1px solid var(--border-color, #f1f5f9);">
                <td style="padding: 10px 14px;">
                    <div style="font-weight: 700; color: var(--text-dark, #1e293b); font-size: 13.5px;">${studentName}</div>
                    <div style="font-size: 11px; color: #64748b; font-family: monospace; margin-top: 1px;">ID: ${studentCode}</div>
                </td>
                <td style="padding: 10px 14px;">
                    <span class="quiz-class-tag">${studentClass}</span>
                </td>
                <td style="padding: 10px 14px; text-align: center;">
                    ${statusBadgeHtml}
                </td>
                <td style="padding: 10px 14px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <input 
                            type="number" 
                            id="score-input-${studentCode}" 
                            class="direct-score-input" 
                            value="${savedScore}" 
                            placeholder="0 - 100" 
                            min="0" 
                            max="100"
                            style="width: 70px; height: 30px; padding: 0 6px; font-size: 13px; font-weight: 700; text-align: center; border: 1px solid var(--border-color, #cbd5e1); border-radius: 6px; background: var(--bg-card, #ffffff); color: var(--text-dark, #1e293b); margin: 0 !important;"
                        >
                        <span id="score-badge-${studentCode}" style="${savedScore !== '' ? 'display:inline-flex;' : 'display:none;'} align-items:center; color:#10b981;" title="Official score saved">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        </span>
                    </div>
                </td>
                <td style="padding: 10px 14px; text-align: right;">
                    <div style="display: inline-flex; gap: 6px; align-items: center;">
                        <button 
                            type="button"
                            class="btn-quiz-check" 
                            onclick="viewStudentAnswers('${studentCode}', '${safeStudentName}', '${safeQuizTitle}', '${safeStudentClass}')"
                            style="background: ${isSubmittedOnline ? '#4f46e5' : '#64748b'}; color: white;"
                            title="${isSubmittedOnline ? 'Inspect submitted answers' : 'View student details & grade'}"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                            <span>Check</span>
                        </button>
                        <button 
                            type="button"
                            id="save-btn-${studentCode}"
                            class="btn-quiz-save" 
                            onclick="saveDirectScore('${studentCode}', '${safeStudentName}', '${safeStudentClass}', '${safeQuizTitle}', this)"
                            style="background: #2563eb; color: white;"
                            title="Save score to ledger"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                            <span>Save</span>
                        </button>
                        ${isSubmittedOnline ? `
                            <button 
                                type="button"
                                class="btn-quiz-check" 
                                onclick="deleteStudentQuizSubmission('${subData.id}', '${safeStudentName}', '${safeQuizTitle}')"
                                style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); padding: 5px 8px;"
                                title="Delete this online submission"
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            </button>
                        ` : ''}
                    </div>
                </td>
            </tr>
        `;
    });
}

window.deleteStudentQuizSubmission = async function(submissionId, studentName, quizTitle) {
    if (!submissionId) return;
    if (!confirm(`Are you sure you want to delete the submission for ${studentName} on "${quizTitle}"?`)) return;
    try {
        await deleteDoc(doc(db, "quiz_results", submissionId));
        alert("Quiz submission deleted successfully!");
        if (window.quizResultsCurrentState?.quizTitle) {
            window.viewQuizResults(window.quizResultsCurrentState.quizTitle, window.quizResultsCurrentState.quizId);
        }
    } catch(err) {
        console.error("Error deleting submission:", err);
        alert("Error deleting submission: " + err.message);
    }
};

window.viewStudentAnswers = async function (studentCode, studentName, quizTitle, studentClass = '') {
    const modal = document.getElementById("studentAnswersModal");
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.style.display = "flex";

    const titleEl = document.getElementById("studentAnswersTitle");
    const subTitleEl = document.getElementById("studentAnswersSubtitle");
    const autoScoreEl = document.getElementById("autoScoreReference");
    const container = document.getElementById("answersDetailContainer");
    const footerEl = document.getElementById("answersModalFooter");

    if (titleEl) titleEl.innerText = `${studentName}'s Submission`;
    if (subTitleEl) subTitleEl.innerText = studentClass ? `Class: ${studentClass} • Student ID: ${studentCode}` : `Student ID: ${studentCode}`;
    if (autoScoreEl) autoScoreEl.innerHTML = `<em>Loading submission details...</em>`;
    if (container) container.innerHTML = "";

    // Pre-fill score in footer
    const currentScore = window.quizResultsCurrentState?.scoresMap?.[studentCode] ?? "";
    const safeStudentName = studentName.replace(/'/g, "\\'");
    const safeStudentClass = studentClass.replace(/'/g, "\\'");
    const safeQuizTitle = quizTitle.replace(/'/g, "\\'");

    if (footerEl) {
        footerEl.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <label style="font-size:13px; font-weight:700; color:var(--text-dark, #1e293b);">Assign Official Grade (0 - 100):</label>
                <input 
                    type="number" 
                    id="modalDirectScoreInput" 
                    value="${currentScore}" 
                    placeholder="Score" 
                    min="0" 
                    max="100" 
                    style="width:80px; height:32px; padding:0 8px; font-size:13.5px; font-weight:700; text-align:center; border-radius:8px; border:1px solid var(--border-color, #cbd5e1); background:var(--bg-card, #fff); color:var(--text-dark, #1e293b); margin:0 !important;"
                >
            </div>
            <div style="display:flex; gap:8px;">
                <button 
                    type="button" 
                    onclick="saveModalGrade('${studentCode}', '${safeStudentName}', '${safeStudentClass}', '${safeQuizTitle}')" 
                    style="background:#2563eb; color:white; border:none; padding:8px 16px; border-radius:8px; font-size:12.5px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:6px; height:34px;"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                    <span>Save Grade & Close</span>
                </button>
            </div>
        `;
    }

    try {
        const q = query(
            collection(db, "quiz_results"),
            where("quizTitle", "==", quizTitle),
            where("studentCode", "==", studentCode)
        );
        const querySnap = await getDocs(q);

        if (querySnap.empty) {
            if (autoScoreEl) {
                autoScoreEl.innerHTML = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        <div>
                            <strong style="color: #f59e0b; font-size:13.5px;">No Online Submission Found</strong>
                            <div style="color: #64748b; font-size:12px; margin-top:2px;">The student has not submitted this quiz digitally yet. You can still manually enter and save their offline grade below.</div>
                        </div>
                    </div>
                `;
            }
            if (container) {
                container.innerHTML = `
                    <div style="padding: 24px; text-align: center; background: var(--bg-card-subtle, #f8fafc); border-radius: 10px; border: 1px dashed var(--border-color, #cbd5e1); color: #64748b;">
                        <p style="margin: 0; font-size: 13px;">No item-by-item responses available for this student.</p>
                    </div>
                `;
            }
            return;
        }

        const subData = querySnap.docs[0].data();
        const score = subData.score !== undefined ? subData.score : 0;
        const totalMax = subData.totalAutoGradable !== undefined ? subData.totalAutoGradable : 0;
        const percentage = totalMax > 0 ? Math.round((score / totalMax) * 100) : 0;
        const responses = subData.responses || [];
        const submittedTime = subData.submittedAt ? new Date(subData.submittedAt).toLocaleString() : "Recently";

        if (autoScoreEl) {
            autoScoreEl.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div>
                        <span style="color: #475569; font-size: 12px; font-weight:600;">Auto-Graded Reference:</span><br>
                        <strong style="font-size: 18px; color: #1e293b;">${score} / ${totalMax} points (${percentage}%)</strong>
                        <div style="color: #64748b; font-size: 11px; margin-top: 2px;">Submitted: ${submittedTime}</div>
                    </div>
                    <button type="button" onclick="document.getElementById('modalDirectScoreInput').value = ${percentage};" style="background:#e0e7ff; color:#4338ca; border:1px solid #c7d2fe; padding:6px 12px; font-size:12px; font-weight:600; border-radius:6px; cursor:pointer;" title="Apply auto-graded % to official score">
                        Apply ${percentage}% as Grade
                    </button>
                </div>
            `;
        }

        if (!responses.length) {
            if (container) container.innerHTML = `<p style="color: #64748b; text-align: center;">No detailed item responses logged for this submission.</p>`;
            return;
        }

        // Fetch Quiz Definition for accurate Answer Key comparison
        let quizDocData = window.quizResultsCurrentState?.quizData;
        if (!quizDocData || !quizDocData.items) {
            try {
                const qQuiz = query(collection(db, "quizzes"), where("title", "==", quizTitle));
                const quizSnap = await getDocs(qQuiz);
                if (!quizSnap.empty) {
                    quizDocData = quizSnap.docs[0].data();
                }
            } catch (e) {
                console.warn("Could not fetch quiz definition for answer key matching:", e);
            }
        }

        const gradableQuizItems = (quizDocData?.items || quizDocData?.questions || []).filter(it => it.type !== 'header' && it.type !== 'passage');

        if (container) {
            container.innerHTML = responses.map((item, index) => {
                const normStudentResp = (item.response || '').toString().trim().toLowerCase();
                
                // Find matching question from quiz definition
                const originalQuizItem = gradableQuizItems[index] || gradableQuizItems.find(q => (q.prompt || q.question || '').trim().toLowerCase() === (item.prompt || '').trim().toLowerCase());

                let isCorrect = item.isCorrect;
                let expectedAnswer = item.expected || '';
                let isEssay = item.isEssay || (originalQuizItem && originalQuizItem.type === 'essay');

                if (isCorrect === undefined && originalQuizItem) {
                    if (originalQuizItem.type === 'fill') {
                        const acceptable = (originalQuizItem.answers || []).map(a => (a || '').toString().trim().toLowerCase());
                        isCorrect = acceptable.length > 0 ? acceptable.includes(normStudentResp) : false;
                        expectedAnswer = (originalQuizItem.answers || []).join(' / ');
                    } else if (originalQuizItem.type === 'mcq' || (!originalQuizItem.type && originalQuizItem.question)) {
                        const correctIdx = originalQuizItem.correct;
                        const correctOption = (originalQuizItem.options && correctIdx !== undefined) ? originalQuizItem.options[correctIdx] : '';
                        isCorrect = correctOption ? (normStudentResp === correctOption.toString().trim().toLowerCase()) : false;
                        expectedAnswer = correctOption;
                    } else if (originalQuizItem.type === 'matching') {
                        const totalPairs = (originalQuizItem.lefts || []).length;
                        isCorrect = totalPairs > 0 ? (normStudentResp.startsWith(`${totalPairs}/${totalPairs}`)) : false;
                        expectedAnswer = (originalQuizItem.lefts || []).map((l, i) => `${l} → ${(originalQuizItem.rights || [])[i]}`).join(', ');
                    } else if (originalQuizItem.type === 'essay') {
                        isEssay = true;
                    }
                }

                // Render Badge & Card Style
                let statusBadge = '';
                let borderLeftColor = '#3b82f6';
                let expectedHtml = '';

                if (isEssay) {
                    statusBadge = `
                        <span style="display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:14px; font-size:11.5px; font-weight:700; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe;">
                            Manual Review
                        </span>
                    `;
                    borderLeftColor = '#3b82f6';
                } else if (isCorrect === true) {
                    statusBadge = `
                        <span style="display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:14px; font-size:11.5px; font-weight:700; background:#dcfce7; color:#15803d; border:1px solid #bbf7d0;">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            Correct
                        </span>
                    `;
                    borderLeftColor = '#10b981';
                } else if (isCorrect === false) {
                    statusBadge = `
                        <span style="display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:14px; font-size:11.5px; font-weight:700; background:#fee2e2; color:#b91c1c; border:1px solid #fecaca;">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            Incorrect
                        </span>
                    `;
                    borderLeftColor = '#ef4444';

                    if (expectedAnswer) {
                        expectedHtml = `
                            <div style="margin-top: 8px; font-size: 12.5px; color: #991b1b; background: #fef2f2; padding: 6px 12px; border-radius: 6px; border: 1px solid #fee2e2; display: flex; align-items: center; gap: 6px;">
                                <strong style="color: #7f1d1d;">Expected Answer:</strong>
                                <span>${escapeHtml(expectedAnswer)}</span>
                            </div>
                        `;
                    }
                }

                return `
                    <div style="border: 1px solid var(--border-color, #e2e8f0); padding: 14px 16px; margin-bottom: 12px; border-radius: 10px; background: var(--bg-card-subtle, #f8fafc); border-left: 5px solid ${borderLeftColor};">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:8px;">
                            <p style="margin: 0; font-weight: 700; color: var(--text-dark, #1e293b); font-size:14px; line-height: 1.4; flex: 1;">
                                Q${index + 1}: ${item.prompt || 'Question'}
                            </p>
                            <div style="flex-shrink: 0;">
                                ${statusBadge}
                            </div>
                        </div>
                        <div style="background: var(--bg-card, #ffffff); border: 1px solid var(--border-color, #e2e8f0); border-radius: 6px; padding: 10px 14px;">
                            <span style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Student Answer:</span>
                            <div style="color: var(--text-dark, #0f172a); font-weight: 600; font-size: 13.5px; margin-top: 3px; white-space: pre-wrap;">${escapeHtml(item.response || 'No answer')}</div>
                            ${expectedHtml}
                        </div>
                    </div>
                `;
            }).join('');
        }

    } catch (err) {
        console.error("Error fetching student submission details:", err);
        if (autoScoreEl) autoScoreEl.innerHTML = `<span style="color: #ef4444;">Error retrieving submission details from database.</span>`;
    }
};

function resolveQuizType(quizTitle, quizData = null) {
    if (quizData && quizData.type) return quizData.type;
    const lower = (quizTitle || '').toLowerCase();
    if (lower.includes("review")) return "Review";
    if (lower.includes("homework") || lower.includes("hw")) return "Homework";
    if (lower.includes("exercise")) return "Exercise";
    if (lower.includes("final") || lower.includes("exam") || lower.includes("midterm")) return "Final Test";
    if (lower.includes("project")) return "Project";
    if (lower.includes("skill")) return "Skill";
    return "Quiz";
}

window.saveModalGrade = async function (studentCode, studentName, studentClass, quizTitle) {
    const input = document.getElementById("modalDirectScoreInput");
    if (!input) return;

    const rawVal = input.value.trim();
    if (rawVal === "") {
        alert("Please enter a numeric score before saving.");
        return;
    }

    const scoreValue = parseFloat(rawVal);
    if (isNaN(scoreValue) || scoreValue < 0 || scoreValue > 100) {
        alert("Please enter a valid numeric score (0 - 100).");
        return;
    }

    try {
        const state = window.quizResultsCurrentState || {};
        let subject = state.quizData?.subject || state.subject || "";
        
        if (!subject || subject === "General") {
            const subjectTag = document.getElementById('quizResultsSubjectTag')?.innerText?.trim();
            if (subjectTag && subjectTag !== "Subject" && subjectTag !== "Loading...") {
                subject = subjectTag;
            } else {
                try {
                    const qSnap = await getDocs(query(collection(db, "quizzes"), where("title", "==", quizTitle)));
                    if (!qSnap.empty && qSnap.docs[0].data().subject) {
                        subject = qSnap.docs[0].data().subject;
                    }
                } catch (e) {
                    console.warn(e);
                }
            }
        }
        if (!subject) subject = (typeof teacherSubject !== "undefined" && teacherSubject && teacherSubject !== "all") ? teacherSubject : "English";

        if (!studentClass || studentClass === "N/A") {
            const matchStudent = (state.eligibleStudents || []).find(s => s.code === studentCode || s.id === studentCode);
            if (matchStudent && matchStudent.studentClass) {
                studentClass = matchStudent.studentClass;
            }
        }

        const resolvedType = resolveQuizType(quizTitle, state.quizData);

        // 1. Unified exam_scores collection (used by Ledger, Students page scores.html, main.js)
        const customDocId = `${studentCode}_${subject}_${quizTitle}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        const examScoreRef = doc(db, "exam_scores", customDocId);

        await setDoc(examScoreRef, {
            studentCode: studentCode,
            studentName: studentName,
            subject: subject,
            studentClass: studentClass || "Grade 9A",
            examName: quizTitle,
            quizName: quizTitle,
            type: resolvedType,
            score: Number(scoreValue),
            updatedAt: new Date()
        }, { merge: true });

        // 2. Legacy scores collection (for backward compatibility)
        const scoreDocId = `${studentCode}_${quizTitle.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const scoreRef = doc(db, "scores", scoreDocId);

        await setDoc(scoreRef, {
            studentCode: studentCode,
            studentName: studentName,
            targetClass: studentClass || "Grade 9A",
            studentClass: studentClass || "Grade 9A",
            subject: subject,
            quizTitle: quizTitle,
            examName: quizTitle,
            type: resolvedType,
            score: Number(scoreValue),
            updatedAt: new Date().toISOString()
        }, { merge: true });

        // 3. Update local state
        const normCode = (studentCode || '').toString().trim().toLowerCase();
        const normName = (studentName || '').toString().trim().toLowerCase();
        if (state.scoresMap) {
            state.scoresMap[normCode] = scoreValue;
            if (normName) state.scoresMap[`name_${normName}`] = scoreValue;
        }

        // 4. Update main table input and checkmark badge
        const mainInput = document.getElementById(`score-input-${studentCode}`);
        if (mainInput) mainInput.value = scoreValue;
        const mainBadge = document.getElementById(`score-badge-${studentCode}`);
        if (mainBadge) mainBadge.style.display = "inline-flex";

        closeAnswersModal();
        alert(`Official score of ${scoreValue} saved for ${studentName}!`);

        if (typeof window.loadAdminTable === "function") {
            window.loadAdminTable();
        }
        if (typeof window.loadScoresTable === "function") {
            window.loadScoresTable();
        }
    } catch (error) {
        console.error("Error saving score from modal:", error);
        alert("Failed to save score: " + error.message);
    }
};

window.closeAnswersModal = function () {
    const modal = document.getElementById("studentAnswersModal");
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = "none";
    }
};

// 4. Save individual student score from table
window.saveDirectScore = async function (studentCode, studentName, studentClass, quizTitle, btn = null) {
    const input = document.getElementById(`score-input-${studentCode}`);
    if (!input) return;

    const rawVal = input.value.trim();
    if (rawVal === "") {
        alert("Please enter a numeric score before saving.");
        return;
    }

    const scoreValue = parseFloat(rawVal);
    if (isNaN(scoreValue) || scoreValue < 0 || scoreValue > 100) {
        alert("Please enter a valid numeric score (0 - 100).");
        return;
    }

    const origBtnText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span style="font-size:11px;">Saving...</span>`;
    }

    try {
        const state = window.quizResultsCurrentState || {};
        let subject = state.quizData?.subject || state.subject || "";
        
        if (!subject || subject === "General") {
            const subjectTag = document.getElementById('quizResultsSubjectTag')?.innerText?.trim();
            if (subjectTag && subjectTag !== "Subject" && subjectTag !== "Loading...") {
                subject = subjectTag;
            } else {
                try {
                    const qSnap = await getDocs(query(collection(db, "quizzes"), where("title", "==", quizTitle)));
                    if (!qSnap.empty && qSnap.docs[0].data().subject) {
                        subject = qSnap.docs[0].data().subject;
                    }
                } catch (e) {
                    console.warn(e);
                }
            }
        }
        if (!subject) subject = (typeof teacherSubject !== "undefined" && teacherSubject && teacherSubject !== "all") ? teacherSubject : "English";

        if (!studentClass || studentClass === "N/A") {
            const matchStudent = (state.eligibleStudents || []).find(s => s.code === studentCode || s.id === studentCode);
            if (matchStudent && matchStudent.studentClass) {
                studentClass = matchStudent.studentClass;
            }
        }

        const resolvedType = resolveQuizType(quizTitle, state.quizData);

        // 1. Save directly to unified "exam_scores" collection
        const customDocId = `${studentCode}_${subject}_${quizTitle}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        const examScoreRef = doc(db, "exam_scores", customDocId);

        await setDoc(examScoreRef, {
            studentCode: studentCode,
            studentName: studentName,
            subject: subject,
            studentClass: studentClass || "Grade 9A",
            examName: quizTitle,
            quizName: quizTitle,
            type: resolvedType,
            score: Number(scoreValue),
            updatedAt: new Date()
        }, { merge: true });

        // 2. Save to legacy "scores" collection
        const scoreDocId = `${studentCode}_${quizTitle.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const scoreRef = doc(db, "scores", scoreDocId);

        await setDoc(scoreRef, {
            studentCode: studentCode,
            studentName: studentName,
            targetClass: studentClass || "Grade 9A",
            studentClass: studentClass || "Grade 9A",
            subject: subject,
            quizTitle: quizTitle,
            examName: quizTitle,
            type: resolvedType,
            score: Number(scoreValue),
            updatedAt: new Date().toISOString()
        }, { merge: true });

        // 3. Update local state
        const normCode = (studentCode || '').toString().trim().toLowerCase();
        const normName = (studentName || '').toString().trim().toLowerCase();
        if (state.scoresMap) {
            state.scoresMap[normCode] = scoreValue;
            if (normName) state.scoresMap[`name_${normName}`] = scoreValue;
        }

        // Show checkmark badge
        const badge = document.getElementById(`score-badge-${studentCode}`);
        if (badge) badge.style.display = "inline-flex";

        if (btn) {
            btn.innerHTML = `✓ Saved`;
            btn.style.background = "#10b981";
            setTimeout(() => {
                btn.innerHTML = origBtnText;
                btn.style.background = "#2563eb";
                btn.disabled = false;
            }, 2000);
        } else {
            alert(`Score of ${scoreValue} saved for ${studentName}!`);
        }

        if (typeof window.loadAdminTable === "function") {
            window.loadAdminTable();
        }
        if (typeof window.loadScoresTable === "function") {
            window.loadScoresTable();
        }
    } catch (error) {
        console.error("Error saving score:", error);
        alert("Failed to save score: " + error.message);
        if (btn) {
            btn.innerHTML = origBtnText;
            btn.disabled = false;
        }
    }
};

// 5. Batch save all entered scores from Quiz Results modal
window.saveAllQuizResultsScores = async function (btn = null) {
    const state = window.quizResultsCurrentState;
    if (!state) return;

    const quizTitle = state.quizTitle;
    const inputs = document.querySelectorAll('#quizResultsTable .direct-score-input');
    if (!inputs || inputs.length === 0) {
        alert("No student score inputs found.");
        return;
    }

    const origText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>Saving All...</span>`;
    }

    let savedCount = 0;
    try {
        let subject = state.quizData?.subject || state.subject || "";
        if (!subject || subject === "General") {
            const subjectTag = document.getElementById('quizResultsSubjectTag')?.innerText?.trim();
            if (subjectTag && subjectTag !== "Subject" && subjectTag !== "Loading...") {
                subject = subjectTag;
            }
        }
        if (!subject) subject = (typeof teacherSubject !== "undefined" && teacherSubject && teacherSubject !== "all") ? teacherSubject : "English";
        const resolvedType = resolveQuizType(quizTitle, state.quizData);

        for (const input of inputs) {
            const val = input.value.trim();
            if (val === "") continue;

            const scoreValue = parseFloat(val);
            if (isNaN(scoreValue)) continue;

            const studentCode = input.id.replace('score-input-', '');
            const student = (state.eligibleStudents || []).find(s => s.code === studentCode || s.id === studentCode);
            const studentName = student ? student.studentName : (input.getAttribute('data-name') || 'Student');
            const studentClass = student ? student.studentClass : (input.getAttribute('data-class') || 'Grade 9A');

            // Save to exam_scores
            const customDocId = `${studentCode}_${subject}_${quizTitle}`.replace(/[^a-zA-Z0-9_-]/g, "_");
            await setDoc(doc(db, "exam_scores", customDocId), {
                studentCode: studentCode,
                studentName: studentName,
                subject: subject,
                studentClass: studentClass,
                examName: quizTitle,
                quizName: quizTitle,
                type: resolvedType,
                score: Number(scoreValue),
                updatedAt: new Date()
            }, { merge: true });

            // Save to legacy scores
            const scoreDocId = `${studentCode}_${quizTitle.replace(/[^a-zA-Z0-9]/g, "_")}`;
            await setDoc(doc(db, "scores", scoreDocId), {
                studentCode: studentCode,
                studentName: studentName,
                targetClass: studentClass,
                studentClass: studentClass,
                subject: subject,
                quizTitle: quizTitle,
                examName: quizTitle,
                type: resolvedType,
                score: Number(scoreValue),
                updatedAt: new Date().toISOString()
            }, { merge: true });

            // Update state & badge
            const normCode = (studentCode || '').toString().trim().toLowerCase();
            const normName = (studentName || '').toString().trim().toLowerCase();
            if (state.scoresMap) {
                state.scoresMap[normCode] = scoreValue;
                if (normName) state.scoresMap[`name_${normName}`] = scoreValue;
            }
            const badge = document.getElementById(`score-badge-${studentCode}`);
            if (badge) badge.style.display = "inline-flex";

            savedCount++;
        }

        alert(`Successfully saved ${savedCount} official score(s) to score database & student records!`);
        if (typeof window.loadAdminTable === "function") {
            window.loadAdminTable();
        }
    } catch (err) {
        console.error("Error saving all quiz scores:", err);
        alert("Error saving scores: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = origText;
            btn.disabled = false;
        }
    }
};
async function loadScoresTable() {
    const tbody = document.querySelector("#scoresTable tbody");
    if (!tbody) return;

    const snap = await getDocs(collection(db, "scores"));
    tbody.innerHTML = "";

    snap.forEach(docSnap => {
        const data = docSnap.data();
        tbody.innerHTML += `
            <tr>
                <td>${data.studentName || '-'}</td>
                <td>${data.targetClass || '-'}</td>
                <td>${data.quizTitle || '-'}</td>
                <td><strong>${data.score}</strong></td>
                <td>
                    <button class="btn-secondary" onclick="editScore('${docSnap.id}', ${data.score})">Edit</button>
                </td>
            </tr>
        `;
    });
}
window.loadScoresTable = loadScoresTable;
// --- DASHBOARD STATISTICS CALCULATOR ---
// --- OPTIMIZED DASHBOARD STATS CALCULATOR (DECOUPLED & RESILIENT) ---
async function updateDashboardStats() {
    try {
        let studentsMap = {};

        // 1. Students Count & Map
        try {
            const studentsSnap = await getDocs(collection(db, "students"));
            const elTotalStudents = document.getElementById('stat-total-students');
            if (elTotalStudents) elTotalStudents.innerText = studentsSnap.size;

            studentsSnap.forEach(doc => {
                studentsMap[doc.id] = { name: doc.data().studentName || 'N/A', total: 0 };
            });
        } catch (e) {
            console.warn("Could not load students for stats:", e);
        }

        // 2. Teachers Count
        try {
            let teacherCount = 0;
            const usersSnap = await getDocs(collection(db, "users"));
            usersSnap.forEach(doc => {
                const r = (doc.data().role || '').toLowerCase();
                if (r === 'teacher') teacherCount++;
            });
            const elTotalTeachers = document.getElementById('stat-total-teachers');
            if (elTotalTeachers) elTotalTeachers.innerText = teacherCount > 0 ? teacherCount : 1;
        } catch (e) {
            const elTotalTeachers = document.getElementById('stat-total-teachers');
            if (elTotalTeachers && (elTotalTeachers.innerText === '...' || !elTotalTeachers.innerText)) {
                elTotalTeachers.innerText = '1';
            }
        }

        // 3. Behavior Points (Highest & Lowest)
        try {
            const pointsSnap = await getDocs(collection(db, "student_points"));
            pointsSnap.forEach(doc => {
                const data = doc.data();
                if (studentsMap[data.studentCode]) {
                    studentsMap[data.studentCode].total += (parseFloat(data.points) || 0);
                }
            });

            let highestName = "N/A", highestScore = -Infinity;
            let lowestName = "N/A", lowestScore = Infinity;
            let hasStudents = false;

            for (const code in studentsMap) {
                hasStudents = true;
                const student = studentsMap[code];
                if (student.total > highestScore) {
                    highestScore = student.total;
                    highestName = student.name;
                }
                if (student.total < lowestScore) {
                    lowestScore = student.total;
                    lowestName = student.name;
                }
            }

            const elHighest = document.getElementById('stat-highest-behavior');
            const elLowest = document.getElementById('stat-lowest-behavior');

            if (hasStudents && highestScore !== -Infinity) {
                if (elHighest) elHighest.innerText = `${highestName} (${highestScore > 0 ? '+' : ''}${highestScore})`;
                if (elLowest) elLowest.innerText = `${lowestName} (${lowestScore > 0 ? '+' : ''}${lowestScore})`;
            } else {
                if (elHighest) elHighest.innerText = "N/A";
                if (elLowest) elLowest.innerText = "N/A";
            }
        } catch (e) {
            console.warn("Could not calculate behavior stats:", e);
        }

        // 4. Total News Count
        try {
            const newsSnap = await getDocs(collection(db, "news_updates"));
            const elTotalNews = document.getElementById('stat-total-news');
            if (elTotalNews) elTotalNews.innerText = newsSnap.size;
        } catch (e) {
            console.warn("Could not load news stats:", e);
        }

        // 5. Total Quizzes Count (Digital + Offline)
        try {
            let totalQuizCount = 0;
            const quizSnap = await getDocs(collection(db, "quizzes"));
            totalQuizCount += quizSnap.size;

            try {
                const manualSnap = await getDocs(collection(db, "system_quizzes"));
                totalQuizCount += manualSnap.size;
            } catch (err) { }

            const elTotalQuizzes = document.getElementById('stat-total-quizzes');
            if (elTotalQuizzes) elTotalQuizzes.innerText = totalQuizCount;
        } catch (e) {
            console.warn("Could not load quiz stats:", e);
        }

    } catch (e) {
        console.error("Dashboard stats calculation error:", e);
    }
}
window.updateDashboardStats = updateDashboardStats;

// 2. Function to filter, sort, and render the table with hidden codes
// --- OPTIMIZED STUDENT TABLE RENDER ---
function renderStudentsTable() {
    const searchInput = document.getElementById('searchStudents');
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const sortBy = document.getElementById('sortStudents')?.value || 'code';
    const filterByClass = document.getElementById('filterClass')?.value || 'all';

    // 1. Filter student array
    const filteredStudents = allStudentsData.filter(s => {
        const matchesSearch = !searchTerm ||
            (s.studentName && s.studentName.toLowerCase().includes(searchTerm)) ||
            (s.studentClass && s.studentClass.toLowerCase().includes(searchTerm)) ||
            (s.id && s.id.toLowerCase().includes(searchTerm));

        const matchesClass = (filterByClass === 'all') || (s.studentClass === filterByClass);

        return matchesSearch && matchesClass;
    });

    // 2. Sort filtered array
    filteredStudents.sort((a, b) => {
        if (sortBy === 'name') return (a.studentName || '').localeCompare(b.studentName || '');
        if (sortBy === 'class') return (a.studentClass || '').localeCompare(b.studentClass || '');
        return (a.id || '').localeCompare(b.id || '');
    });

    const tbody = document.querySelector('#studentsTable tbody');
    if (!tbody) return;

    if (filteredStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--text-gray);">No matching students found.</td></tr>`;
        return;
    }

    // 3. BATCH DOM CREATION: Build HTML array in memory first
    const rowsHtml = filteredStudents.map(student => `
        <tr>
            <td>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span id="code-${student.id}" style="font-weight: 600; letter-spacing: 2px;">•••••</span>
                    <button class="eye-btn" onclick="toggleCodeVisibility('${student.id}')" title="Show/Hide Code">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0"/>
                            <path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8m8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7"/>
                        </svg>
                    </button>
                </div>
            </td>
            <td>${student.studentName}</td>
            <td><span style="color:var(--primary-blue); font-weight:600;">${student.studentClass || 'N/A'}</span></td>
            <td>
                <div class="kebab-menu">
                    <button class="kebab-btn" onclick="toggleMenu(event, '${student.id}')">⋮</button>
                    <div id="menu-${student.id}" class="dropdown-menu">
                        <button class="dropdown-item" onclick="editStudentProfile('${student.id}')">Edit Student</button>
                        <button class="dropdown-item" onclick="generateNewUniqueCode('${student.id}')">Generate New Code</button>
                        <button class="dropdown-item danger" onclick="deleteStudentProfile('${student.id}')">Delete Student</button>
                    </div>
                </div>
            </td>
        </tr>
    `);

    // 4. Inject into DOM ONCE to prevent lag and UI freezing
    tbody.innerHTML = rowsHtml.join('');
}

// Attach debounced event listener (200ms delay)
document.getElementById('searchStudents')?.addEventListener('input', debounce(renderStudentsTable, 200));

// 3. Event Listener for the Class Filter
document.getElementById('filterClass')?.addEventListener('change', renderStudentsTable);

// Search and sort listeners
document.getElementById('searchStudents')?.addEventListener('input', renderStudentsTable);
document.getElementById('sortStudents')?.addEventListener('change', renderStudentsTable);


// 4. Function to toggle the code visibility
window.toggleCodeVisibility = function (studentId) {
    const span = document.getElementById(`code-${studentId}`);
    if (!span) return;

    if (span.innerText === '•••••') {
        span.innerText = studentId; // Show real code
        span.style.letterSpacing = 'normal'; // Reset spacing
    } else {
        span.innerText = '•••••'; // Hide code
        span.style.letterSpacing = '2px'; // Add spacing for dots
    }
};

// 3. Event Listeners for Search and Sort
document.getElementById('searchStudents')?.addEventListener('input', renderStudentsTable);
document.getElementById('sortStudents')?.addEventListener('change', renderStudentsTable);

// 4. Menu Toggle Logic (Attach to window so inline HTML onclick works)
window.toggleMenu = function (event, id) {
    event.stopPropagation(); // Prevents the click from closing the menu immediately

    // Close all other open menus first
    document.querySelectorAll('.dropdown-menu').forEach(menu => {
        if (menu.id !== `menu-${id}`) menu.classList.remove('show');
    });

    // Toggle the clicked menu
    document.getElementById(`menu-${id}`).classList.toggle('show');
}

// Close dropdowns when clicking anywhere outside of them
window.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(menu => menu.classList.remove('show'));
});

// 5. Action Functions (Make sure these exist and are attached to window)
window.generateNewUniqueCode = async function (oldCode) {
    if (confirm(`Are you sure you want to generate a new code for student ${oldCode}? The old code will be disabled.`)) {
        // Add your logic here to generate a code, update the Firebase document ID/data, 
        // and delete the old document if necessary.
        // After updating Firebase:
        // loadStudentsDirectory(); 
    }
};

// --- MANAGE SCORE LEDGER LOGIC ---

function showScoreLedger() {
    const selectedQuiz = document.getElementById('ledgerQuizSelect').value;
    const ledgerContainer = document.getElementById('scoreLedgerContainer');
    const ledgerTitle = document.getElementById('activeLedgerTitle');
    const tbody = document.getElementById('manageScoreTbody');

    // 1. Validation check
    if (!selectedQuiz) {
        alert("Please select a Quiz or Review from the dropdown first.");
        ledgerContainer.style.display = "none"; // Keep hidden
        return;
    }

    // 2. Unhide the table container
    ledgerContainer.style.display = "block";

    // 3. Update the title based on selection
    const selectedText = document.getElementById('ledgerQuizSelect').options[document.getElementById('ledgerQuizSelect').selectedIndex].text;
    ledgerTitle.innerText = `Ledger Results: ${selectedText}`;

    // 4. Fetch the data (Replace this with your actual Firebase/Database fetch function)
    fetchAndRenderScores(selectedQuiz, tbody);
}

// Dummy function to represent your data fetching
async function fetchAndRenderScores(quizId, tbodyElement) {
    // Clear previous rows
    tbodyElement.innerHTML = "<tr><td colspan='7' style='text-align:center;'>Loading scores...</td></tr>";

    try {
        // TODO: Replace with your actual database query for the selected quizId
        /* 
        const q = query(collection(db, "scores"), where("examId", "==", quizId));
        const querySnapshot = await getDocs(q);
        */

        // Simulated rendering after data fetch:
        tbodyElement.innerHTML = ""; // Clear loading text

        // Example Row Injection (You will loop through your querySnapshot here)
        tbodyElement.innerHTML += `
            <tr>
                <td>${quizId}</td>
                <td>Sample Subject</td>
                <td>John Doe</td>
                <td>Class A</td>
                <td>STU-001</td>
                <td><strong>85/100</strong></td>
                <td>
                    <button class="edit-btn">Edit</button>
                </td>
            </tr>
        `;
    } catch (e) {
        console.error("Error fetching ledger: ", e);
        tbodyElement.innerHTML = "<tr><td colspan='7' style='text-align:center; color: red;'>Error loading data.</td></tr>";
    }
}

// --- HELPER: PARSE & FORMAT EXCEL DATES ---
function formatExcelDate(rawVal) {
    if (rawVal === undefined || rawVal === null || rawVal === "") return "";
    if (typeof rawVal === "number") {
        // Convert Excel serial date to YYYY-MM-DD
        const jsDate = new Date(Math.round((rawVal - 25569) * 86400 * 1000));
        if (!isNaN(jsDate.getTime())) {
            const y = jsDate.getUTCFullYear();
            const m = String(jsDate.getUTCMonth() + 1).padStart(2, '0');
            const d = String(jsDate.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
    }
    const str = String(rawVal).trim();
    // Handle DD/MM/YYYY or DD-MM-YYYY
    const ddmmyyyy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (ddmmyyyy) {
        const d = String(ddmmyyyy[1]).padStart(2, '0');
        const m = String(ddmmyyyy[2]).padStart(2, '0');
        const y = ddmmyyyy[3];
        return `${y}-${m}-${d}`;
    }
    // Handle YYYY/MM/DD or YYYY-MM-DD
    const yyyymmdd = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (yyyymmdd) {
        const y = yyyymmdd[1];
        const m = String(yyyymmdd[2]).padStart(2, '0');
        const d = String(yyyymmdd[3]).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return str;
}

// --- DOWNLOAD STUDENTS TEMPLATE (PRE-POPULATED WITH EXISTING STUDENTS) ---
window.downloadStudentsTemplate = async function () {
    try {
        const studentsSnap = await getDocs(collection(db, "students"));
        const studentsList = [];

        studentsSnap.forEach(docSnap => {
            const data = docSnap.data();
            studentsList.push({
                code: docSnap.id,
                name: data.studentName || "",
                studentClass: data.studentClass || data.class || data.Class || "",
                birthDate: data.birthDate || data.dateOfBirth || "",
                email: data.studentEmail || data.email || ""
            });
        });

        // Sort by Class then Student Name
        studentsList.sort((a, b) => {
            const classCompare = a.studentClass.localeCompare(b.studentClass, undefined, { numeric: true, sensitivity: 'base' });
            if (classCompare !== 0) return classCompare;
            return a.name.localeCompare(b.name);
        });

        const wsData = [
            ["No", "Student Code", "Student Name", "Class", "Birth Date (YYYY-MM-DD)", "Google Classroom Email"]
        ];

        studentsList.forEach((st, idx) => {
            wsData.push([
                idx + 1,
                st.code,
                st.name,
                st.studentClass,
                st.birthDate,
                st.email
            ]);
        });

        const worksheet = XLSX.utils.aoa_to_sheet(wsData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Students");

        worksheet["!cols"] = [
            { wch: 6 },  // No
            { wch: 16 }, // Student Code
            { wch: 32 }, // Student Name
            { wch: 16 }, // Class
            { wch: 22 }, // Birth Date
            { wch: 36 }  // Google Classroom Email
        ];

        XLSX.writeFile(workbook, "Students_Database_Template.xlsx");

    } catch (err) {
        console.error("Error generating students template:", err);
        alert("Failed to export students template: " + err.message);
    }
};

// --- BULK UPLOAD & SMART MERGE STUDENTS LOGIC ---
async function processBulkStudents() {
    const fileInput = document.getElementById('bulkStudentsFile');
    const file = fileInput ? fileInput.files[0] : null;

    if (!file) {
        alert("Please select an Excel (.xlsx, .csv) file to upload.");
        return;
    }

    const uploadBtn = document.getElementById('uploadBulkStudentsBtn');
    const originalText = uploadBtn ? uploadBtn.innerText : "Upload";

    try {
        if (uploadBtn) {
            uploadBtn.innerText = "Processing...";
            uploadBtn.disabled = true;
        }

        const data = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(data), { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet);

        if (!jsonData || jsonData.length === 0) {
            alert("The uploaded file appears to be empty.");
            return;
        }

        // 1. Fetch all existing students to match codes & prevent duplicates
        const existingSnap = await getDocs(collection(db, "students"));
        const studentsByCode = new Map();
        const studentsByNameClass = new Map();

        existingSnap.forEach(docSnap => {
            const sData = docSnap.data();
            const code = docSnap.id.toUpperCase().trim();
            studentsByCode.set(code, { id: docSnap.id, ...sData });

            const normKey = `${(sData.studentName || '').toLowerCase().trim()}_${(sData.studentClass || sData.class || '').toLowerCase().trim()}`;
            if (normKey !== '_') {
                studentsByNameClass.set(normKey, { id: docSnap.id, ...sData });
            }
        });

        let updatedCount = 0;
        let createdCount = 0;
        let skippedCount = 0;

        // 2. Iterate through rows
        for (const row of jsonData) {
            const rawCode = String(row["Student Code"] || row["Code"] || row["studentCode"] || "").toUpperCase().trim();
            const name = String(row["Student Name"] || row["Name"] || row["studentName"] || "").trim();
            const sClass = String(row["Class"] || row["Class Room"] || row["studentClass"] || row["class"] || "").trim();
            const rawBirthDate = row["Birth Date"] || row["Birth Date (YYYY-MM-DD)"] || row["BirthDate"] || row["DOB"] || row["Date of Birth"] || row["birthDate"] || "";
            const birthDate = formatExcelDate(rawBirthDate);
            const email = String(row["Google Classroom Email"] || row["Email"] || row["Student Email"] || row["studentEmail"] || row["email"] || "").trim().toLowerCase();

            if (!name && !rawCode) {
                skippedCount++;
                continue;
            }

            // Find existing student by Code first, then by Name + Class
            let targetStudent = null;
            if (rawCode && studentsByCode.has(rawCode)) {
                targetStudent = studentsByCode.get(rawCode);
            } else if (name && sClass) {
                const normKey = `${name.toLowerCase()}_${sClass.toLowerCase()}`;
                if (studentsByNameClass.has(normKey)) {
                    targetStudent = studentsByNameClass.get(normKey);
                }
            }

            if (targetStudent) {
                // UPDATE / MERGE existing student record (Preserves Student Code, Scores & History)
                const updatePayload = {};
                if (name) updatePayload.studentName = name;
                if (sClass) updatePayload.studentClass = sClass;
                if (birthDate) updatePayload.birthDate = birthDate;
                if (email) updatePayload.studentEmail = email;

                await setDoc(doc(db, "students", targetStudent.id), updatePayload, { merge: true });
                updatedCount++;
            } else if (name && sClass) {
                // CREATE NEW student with unique code
                const uniqueCode = rawCode || (await generateUniqueStudentCode());

                const newStudentPayload = {
                    studentName: name,
                    studentClass: sClass,
                    photoUrl: ""
                };
                if (birthDate) newStudentPayload.birthDate = birthDate;
                if (email) newStudentPayload.studentEmail = email;

                await setDoc(doc(db, "students", uniqueCode), newStudentPayload, { merge: true });

                // Add to lookup maps in case duplicate rows exist in same upload file
                studentsByCode.set(uniqueCode, { id: uniqueCode, ...newStudentPayload });
                studentsByNameClass.set(`${name.toLowerCase()}_${sClass.toLowerCase()}`, { id: uniqueCode, ...newStudentPayload });

                createdCount++;
            } else {
                skippedCount++;
            }
        }

        alert(`Students Database Sync Complete!\n• Updated Existing Students: ${updatedCount}\n• Registered New Students: ${createdCount}${skippedCount > 0 ? `\n• Skipped (Incomplete Data): ${skippedCount}` : ''}\n\n✓ All student exam scores, points, and records remain 100% safe and intact.`);

        fileInput.value = "";

        // Refresh all student views
        if (typeof loadStudentsDirectory === "function") loadStudentsDirectory();
        if (typeof renderDbStudentsTable === "function") renderDbStudentsTable();
        if (typeof loadPointsTable === "function") loadPointsTable();
        if (typeof window.loadSystemDatabases === "function") window.loadSystemDatabases();

    } catch (err) {
        console.error("Error processing Excel file:", err);
        alert("Error processing Excel file: " + err.message);
    } finally {
        if (uploadBtn) {
            uploadBtn.innerText = originalText;
            uploadBtn.disabled = false;
        }
    }
}

// Bind button event listener
document.getElementById('uploadBulkStudentsBtn')?.addEventListener('click', processBulkStudents);
// --- SAFE DATABASE LOAD FOR ADMINS & TEACHERS ---
// --- UNIFIED SYSTEM DATABASE LOADER ---
window.loadSystemDatabases = async function () {
    try {
        console.log("--- STARTING DATABASE LOAD ---");

        // 1. Fetch Subject Dropdown Elements
        const subjTbody = document.querySelector("#subjectsTable tbody");
        const subjSelect = document.getElementById("directSubjectSelect");
        const ledgerSubjSelect = document.getElementById("ledgerSubjectSelect");
        const quizSubjSelect = document.getElementById("quizSubject");
        const manualQuizSubjSelect = document.getElementById("newManualQuizSubject");
        const bulkSubjSelect = document.getElementById("bulkSubjectSelect"); // Bulk Upload Dropdown

        // Reset Subject Dropdowns
        if (subjTbody) subjTbody.innerHTML = "";
        if (subjSelect) subjSelect.innerHTML = '<option value="">-- Select Subject --</option>';
        if (ledgerSubjSelect) ledgerSubjSelect.innerHTML = '<option value="">-- Choose a Subject --</option>';
        if (quizSubjSelect) quizSubjSelect.innerHTML = '<option value="">-- Select Subject --</option>';
        if (manualQuizSubjSelect) manualQuizSubjSelect.innerHTML = '<option value="">-- Select Subject --</option>';
        if (bulkSubjSelect) bulkSubjSelect.innerHTML = '<option value="">-- Select Subject --</option>';

        // 2. Extract & Populate Unique Subjects
        const uniqueSubjects = new Set();

        if (userRole === 'admin') {
            try {
                const usersSnap = await getDocs(collection(db, "users"));
                usersSnap.forEach(doc => {
                    const data = doc.data();
                    const sub = data.subject || data.Subject || data.course;
                    if (data.role === 'teacher' && sub && sub !== "Unassigned") {
                        sub.split(',').map(s => s.trim()).filter(Boolean).forEach(s => uniqueSubjects.add(s));
                    }
                });
            } catch (err) {
                console.warn("User collection read restricted:", err.message);
            }
        } else if (teacherSubject && teacherSubject !== "Unassigned") {
            teacherSubject.split(',').map(s => s.trim()).filter(Boolean).forEach(s => uniqueSubjects.add(s));
        }

        // Loop and populate subject options
        Array.from(uniqueSubjects).sort().forEach(name => {
            if (subjTbody) subjTbody.innerHTML += `<tr><td><strong>${name}</strong></td><td><span style="background: #eef2ff; color: var(--primary-blue); padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">Teacher Linked</span></td></tr>`;
            if (subjSelect) subjSelect.innerHTML += `<option value="${name}">${name}</option>`;
            if (ledgerSubjSelect) ledgerSubjSelect.innerHTML += `<option value="${name}">${name}</option>`;
            if (quizSubjSelect) quizSubjSelect.innerHTML += `<option value="${name}">${name}</option>`;
            if (manualQuizSubjSelect) manualQuizSubjSelect.innerHTML += `<option value="${name}">${name}</option>`;
            if (bulkSubjSelect) bulkSubjSelect.innerHTML += `<option value="${name}">${name}</option>`;
        });

        // Pre-select assigned subject for teacher accounts
        if (userRole !== 'admin' && teacherSubject) {
            if (subjSelect) subjSelect.value = teacherSubject;
            if (ledgerSubjSelect) ledgerSubjSelect.value = teacherSubject;
            if (bulkSubjSelect) bulkSubjSelect.value = teacherSubject;
        }

        // Also keep Attendance subject dropdown synced
        if (typeof populateAttendanceSubjects === 'function') {
            populateAttendanceSubjects();
        }

        // 3. Fetch Class Dropdown Elements
        const classTbody = document.querySelector("#classesTable tbody");
        const classSelect = document.getElementById("directClassSelect");
        const ledgerClassSelect = document.getElementById("ledgerClassSelect");
        const quizClassSelect = document.getElementById("quizTargetClass");
        const manualQuizClassSelect = document.getElementById("newManualQuizClass");
        const bulkClassSelect = document.getElementById("bulkClassSelect"); // Bulk Upload Dropdown

        // Reset Class Dropdowns
        if (classTbody) classTbody.innerHTML = "";
        if (classSelect) classSelect.innerHTML = '<option value="">-- Select Class --</option>';
        if (ledgerClassSelect) ledgerClassSelect.innerHTML = '<option value="">-- Choose a Class --</option>';
        if (quizClassSelect) quizClassSelect.innerHTML = '<option value="">-- Select Target Class --</option><option value="All Classes">All Classes</option>';
        if (manualQuizClassSelect) manualQuizClassSelect.innerHTML = '<option value="">-- Select Target Class --</option><option value="All Classes">All Classes</option>';
        if (bulkClassSelect) bulkClassSelect.innerHTML = '<option value="">-- Select Class --</option>';

        // 4. Extract & Populate Unique Classes from Student Records
        try {
            const studentsSnap = await getDocs(collection(db, "students"));
            const uniqueClasses = new Set();
            studentsSnap.forEach(doc => {
                const data = doc.data();
                const studentClass = data.studentClass || data.class || data.className || data.Class;
                if (studentClass) uniqueClasses.add(studentClass);
            });

            const sortedClasses = Array.from(uniqueClasses).sort();

            // Populate multi-select checkbox options for Manual Offline Exam
            const manualQuizOptionsContainer = document.getElementById("manualQuizClassOptions");
            if (manualQuizOptionsContainer) {
                let optionsHtml = `
                    <label class="multi-select-option-row">
                        <input type="checkbox" value="All Classes" onchange="onManualQuizClassCheckboxChange()">
                        <span>All Classes</span>
                    </label>
                `;
                sortedClasses.forEach(name => {
                    optionsHtml += `
                        <label class="multi-select-option-row">
                            <input type="checkbox" value="${name}" onchange="onManualQuizClassCheckboxChange()">
                            <span>${name}</span>
                        </label>
                    `;
                });
                manualQuizOptionsContainer.innerHTML = optionsHtml;
                updateManualQuizClassLabel();
            }

            // Populate multi-select checkbox options for Create Quiz
            const quizOptionsContainer = document.getElementById("quizClassOptions");
            if (quizOptionsContainer) {
                let qOptionsHtml = `
                    <label class="multi-select-option-row">
                        <input type="checkbox" value="All Classes" onchange="onQuizClassCheckboxChange(this)">
                        <span><strong>All Classes</strong></span>
                    </label>
                `;
                sortedClasses.forEach(name => {
                    qOptionsHtml += `
                        <label class="multi-select-option-row">
                            <input type="checkbox" value="${name}" onchange="onQuizClassCheckboxChange(this)">
                            <span>${name}</span>
                        </label>
                    `;
                });
                quizOptionsContainer.innerHTML = qOptionsHtml;
                updateQuizClassLabel();
            }

            // Loop and populate class options for standard select elements
            sortedClasses.forEach(name => {
                if (classTbody) classTbody.innerHTML += `<tr><td><strong>${name}</strong></td><td><span style="background: #ecfdf5; color: #10b981; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">Student Linked</span></td></tr>`;
                if (classSelect) classSelect.innerHTML += `<option value="${name}">${name}</option>`;
                if (ledgerClassSelect) ledgerClassSelect.innerHTML += `<option value="${name}">${name}</option>`;
                if (manualQuizClassSelect) manualQuizClassSelect.innerHTML += `<option value="${name}">${name}</option>`;
                if (bulkClassSelect) bulkClassSelect.innerHTML += `<option value="${name}">${name}</option>`;
            });

            if (typeof populateAssignmentReminderDropdowns === 'function') {
                populateAssignmentReminderDropdowns();
            }
        } catch (err) {
            console.warn("Students collection read restricted:", err.message);
        }

        // 5. Populate Quizzes Table (Digital + Offline)
        // 5. Populate Quizzes Table (Digital + Offline + Classroom)
        const quizTbody = document.querySelector("#quizzesDatabaseTable tbody");
        if (quizTbody) {
            try {
                // Fetch offline/classroom quizzes (system_quizzes)
                const manualSnap = await getDocs(collection(db, "system_quizzes"));

                // Helper for Quiz Type Badges
                const getQuizTypeBadge = (type) => {
                    const rawT = type || 'Quiz';
                    let t = rawT;
                    if (rawT === 'Skill' || rawT === 'Project') t = 'Practical Test';
                    if (rawT === 'Final Test') t = 'Final Exam';

                    let bg = 'rgba(37, 99, 235, 0.1)';
                    let color = '#2563eb';
                    let border = 'rgba(37, 99, 235, 0.25)';

                    if (t === 'Final Exam') {
                        bg = 'rgba(220, 38, 38, 0.1)';
                        color = '#dc2626';
                        border = 'rgba(220, 38, 38, 0.25)';
                    } else if (t === 'Review') {
                        bg = 'rgba(147, 51, 234, 0.1)';
                        color = '#9333ea';
                        border = 'rgba(147, 51, 234, 0.25)';
                    } else if (t === 'Homework') {
                        bg = 'rgba(234, 88, 12, 0.1)';
                        color = '#ea580c';
                        border = 'rgba(234, 88, 12, 0.25)';
                    } else if (t === 'Exercise') {
                        bg = 'rgba(22, 163, 74, 0.1)';
                        color = '#16a34a';
                        border = 'rgba(22, 163, 74, 0.25)';
                    } else if (t === 'Practical Test') {
                        bg = 'rgba(13, 148, 136, 0.1)';
                        color = '#0d9488';
                        border = 'rgba(13, 148, 136, 0.25)';
                    }

                    return `<span style="background: ${bg}; color: ${color}; border: 1px solid ${border}; padding: 3px 10px; border-radius: 12px; font-size: 11.5px; font-weight: 700;">${t}</span>`;
                };

                const getSourceBadge = (source) => {
                    if (source === 'google_classroom') {
                        return `<span style="background: rgba(59, 130, 246, 0.1); color: #2563eb; border: 1px solid rgba(59, 130, 246, 0.25); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; margin-left: 6px;">Classroom</span>`;
                    }
                    return '';
                };

                // Map to group unique assignments by (title + subject)
                const assignmentMap = new Map();
                const duplicateDocIdsToDelete = [];

                // 1. Process documents purely from system_quizzes
                manualSnap.forEach(docSnap => {
                    const data = docSnap.data();
                    const title = (data.name || '').trim();
                    const sub = (data.subject || 'English').trim();
                    const cls = data.targetClass || '';
                    const type = data.type || (title.toLowerCase().includes('review') ? 'Review' : 'Quiz');
                    const source = data.source || (docSnap.id.startsWith('gclass_') ? 'google_classroom' : 'offline');

                    if (!title) return;

                    const groupKey = `${title.toLowerCase()}::${sub.toLowerCase()}`;

                    if (assignmentMap.has(groupKey)) {
                        // Already exists: merge classes
                        const existing = assignmentMap.get(groupKey);
                        if (cls) {
                            cls.split(',').map(c => c.trim()).filter(Boolean).forEach(c => existing.classesSet.add(c));
                        }
                        if (source === 'google_classroom') existing.source = 'google_classroom';
                        
                        // Mark redundant auto-generated duplicate doc for cleanup
                        if (docSnap.id.startsWith('offline_') || docSnap.id.startsWith('gclass_')) {
                            duplicateDocIdsToDelete.push(docSnap.id);
                        }
                    } else {
                        const classesSet = new Set();
                        if (cls) {
                            cls.split(',').map(c => c.trim()).filter(Boolean).forEach(c => classesSet.add(c));
                        }
                        assignmentMap.set(groupKey, {
                            docId: docSnap.id,
                            title: title,
                            subject: sub,
                            type: type,
                            source: source,
                            classesSet: classesSet
                        });
                    }
                });

                // Asynchronously clean up redundant duplicate documents in Firestore
                if (duplicateDocIdsToDelete.length > 0) {
                    duplicateDocIdsToDelete.forEach(id => {
                        deleteDoc(doc(db, "system_quizzes", id)).catch(() => {});
                    });
                }

                // 2. Render Deduplicated Table Rows
                const quizRows = [];
                assignmentMap.forEach((item) => {
                    const classList = Array.from(item.classesSet).sort();
                    const classDisplay = classList.length > 0 ? classList.join(', ') : 'All Classes';

                    quizRows.push(`
                        <tr>
                            <td><strong>${item.title}</strong></td>
                            <td>${getQuizTypeBadge(item.type)}${getSourceBadge(item.source)}</td>
                            <td>${item.subject}</td>
                            <td>${classDisplay}</td>
                            <td style="text-align: center; position: relative;">
                                <div class="db-action-kebab" style="position: relative; display: inline-block;">
                                    <button type="button" class="card-kebab-btn" onclick="toggleOfflineQuizKebab(event, '${item.docId}')" title="Actions">
                                        ⋮
                                    </button>
                                    <div id="offlineQuizKebab_${item.docId}" class="profile-card-dropdown hidden" style="top: 36px; right: 0; min-width: 120px; z-index: 100;">
                                        <button type="button" class="profile-dropdown-item" onclick="openEditOfflineQuizModal('${item.docId}')">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                                            <span>Edit</span>
                                        </button>
                                        <button type="button" class="profile-dropdown-item" style="color: #ef4444 !important;" onclick="deleteSystemRecord('system_quizzes', '${item.docId}')">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                            <span>Delete</span>
                                        </button>
                                    </div>
                                </div>
                            </td>
                        </tr>
                    `);
                });

                // Inject into DOM in a single batch operation
                if (quizRows.length > 0) {
                    quizTbody.innerHTML = quizRows.join('');
                } else {
                    quizTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-gray);">No offline exams found in database.</td></tr>`;
                }

            } catch (err) {
                console.warn("Error loading quiz records:", err.message);
                quizTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: red;">Error loading quiz database.</td></tr>`;
            }
        }

        if (typeof renderDbStudentsTable === "function") {
            renderDbStudentsTable();
        }
        console.log("--- DATABASE LOAD COMPLETE ---");

    } catch (e) {
        console.error("Error loading linked databases:", e.message);
    }
};

// --- MULTI-SELECT CHECKBOX DROPDOWN LOGIC ---
window.toggleMultiSelectDropdown = function (dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains('open');
    document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('open'));
    if (!isOpen) dropdown.classList.add('open');
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select-dropdown')) {
        document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('open'));
    }
    if (!e.target.closest('.db-action-kebab')) {
        document.querySelectorAll('.profile-card-dropdown, .kebab-dropdown').forEach(d => d.classList.add('hidden'));
    }
});

window.onManualQuizClassCheckboxChange = function () {
    updateManualQuizClassLabel();
};

function getSelectedManualQuizClasses() {
    const checkboxes = document.querySelectorAll('#manualQuizClassOptions input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);
    return selected;
}

function updateManualQuizClassLabel() {
    const label = document.getElementById('manualQuizClassLabel');
    if (!label) return;
    const selected = getSelectedManualQuizClasses();
    if (selected.length === 0) {
        label.innerText = '-- Select Target Class --';
    } else if (selected.includes('All Classes')) {
        label.innerText = 'All Classes';
    } else if (selected.length === 1) {
        label.innerText = selected[0];
    } else {
        label.innerText = `${selected.length} Classes Selected (${selected.join(', ')})`;
    }
}

// --- CREATE QUIZ MULTI-SELECT CHECKBOX LOGIC ---
window.onQuizClassCheckboxChange = function (cb) {
    if (cb && cb.value === 'All Classes') {
        const otherCheckboxes = document.querySelectorAll('#quizClassOptions input[type="checkbox"]:not([value="All Classes"])');
        if (cb.checked) {
            otherCheckboxes.forEach(c => c.checked = false);
        }
    } else if (cb && cb.checked) {
        const allCb = document.querySelector('#quizClassOptions input[type="checkbox"][value="All Classes"]');
        if (allCb) allCb.checked = false;
    }
    updateQuizClassLabel();
};

function getSelectedQuizClasses() {
    const checkboxes = document.querySelectorAll('#quizClassOptions input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

function updateQuizClassLabel() {
    const label = document.getElementById('quizClassLabel');
    if (!label) return;
    const selected = getSelectedQuizClasses();
    if (selected.length === 0) {
        label.innerText = '-- Select Target Class --';
    } else if (selected.includes('All Classes')) {
        label.innerText = 'All Classes';
    } else if (selected.length === 1) {
        label.innerText = selected[0];
    } else {
        label.innerText = `${selected.length} Classes Selected (${selected.join(', ')})`;
    }
}

function setQuizClasses(classesList) {
    const checkboxes = document.querySelectorAll('#quizClassOptions input[type="checkbox"]');
    checkboxes.forEach(cb => {
        if (!classesList || classesList.length === 0) {
            cb.checked = false;
        } else if (classesList.includes('All Classes') || classesList.includes('All') || classesList.includes('all')) {
            cb.checked = (cb.value === 'All Classes');
        } else {
            cb.checked = classesList.includes(cb.value);
        }
    });
    updateQuizClassLabel();
}
window.setQuizClasses = setQuizClasses;

// --- ACTIVE CLASSES & SUBJECTS SHOW/HIDE TOGGLE LOGIC ---
window.toggleActiveClassesTable = function () {
    const container = document.getElementById('containerClassesTable');
    const btn = document.getElementById('btnToggleClassesTable');
    if (!container || !btn) return;

    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.innerText = 'Hide Table';
        btn.style.background = '#64748b';
    } else {
        container.classList.add('hidden');
        btn.innerText = 'Show Table';
        btn.style.background = 'var(--primary-blue)';
    }
};

window.toggleActiveSubjectsTable = function () {
    const container = document.getElementById('containerSubjectsTable');
    const btn = document.getElementById('btnToggleSubjectsTable');
    if (!container || !btn) return;

    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.innerText = 'Hide Table';
        btn.style.background = '#64748b';
    } else {
        container.classList.add('hidden');
        btn.innerText = 'Show Table';
        btn.style.background = 'var(--primary-blue)';
    }
};

// --- DATABASE INITIALIZATION EVENT LISTENERS ---
document.addEventListener("DOMContentLoaded", () => {
    // Initial system load on page boot
    if (typeof window.loadSystemDatabases === "function") {
        window.loadSystemDatabases();
    }

    // FIX: Attach event listener to the sidebar MENU BUTTON instead of the tab content container
    const manageDatabasesBtn = document.querySelector('[data-tab="tab-view-ledgers"]');
    if (manageDatabasesBtn) {
        manageDatabasesBtn.addEventListener('click', () => {
            if (typeof window.loadSystemDatabases === "function") {
                window.loadSystemDatabases();
            }
        });
    }
});

async function addManualQuiz() {
    const input = document.getElementById('newManualQuiz');
    const typeSelect = document.getElementById('newManualQuizType');
    const subjectSelect = document.getElementById('newManualQuizSubject');
    const submitBtn = document.querySelector("button[onclick='addManualQuiz()']");

    const examName = input ? input.value.trim() : "";
    const quizType = typeSelect ? typeSelect.value : "Quiz";
    const subject = subjectSelect ? subjectSelect.value : "";
    const selectedClasses = getSelectedManualQuizClasses();
    const targetClassStr = selectedClasses.includes("All Classes") ? "All Classes" : selectedClasses.join(", ");

    // 1. Validate Form Inputs
    if (!examName || !subject || selectedClasses.length === 0) {
        alert("Please enter an Exam Name, select a Subject, and check at least one Target Class.");
        return;
    }

    try {
        // 2. Lock UI Button to prevent rapid double-clicks
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = "Checking & Adding...";
        }

        // 3. Query Firestore for Existing Duplicates
        const dupQuery = query(
            collection(db, "system_quizzes"),
            where("name", "==", examName),
            where("subject", "==", subject),
            where("targetClass", "==", targetClassStr)
        );
        const dupSnap = await getDocs(dupQuery);

        if (!dupSnap.empty) {
            alert(`Duplicate Exam Blocked!\nAn offline exam named "${examName}" already exists for ${subject} (${targetClassStr}).`);
            return;
        }

        // 4. Create New Offline Exam Document
        await addDoc(collection(db, "system_quizzes"), {
            name: examName,
            type: quizType,
            subject: subject,
            targetClass: targetClassStr,
            targetClassesList: selectedClasses,
            createdAt: new Date().toISOString()
        });

        alert(`Offline exam "${examName}" [${quizType}] added successfully for target classes: ${targetClassStr}!`);

        // Reset Inputs
        input.value = "";
        subjectSelect.value = "";
        if (typeSelect) typeSelect.value = "Quiz";
        document.querySelectorAll('#manualQuizClassOptions input[type="checkbox"]').forEach(cb => cb.checked = false);
        updateManualQuizClassLabel();

        // Refresh Table Data
        if (typeof window.loadSystemDatabases === "function") {
            await window.loadSystemDatabases();
        }
    } catch (e) {
        alert("Error adding offline exam: " + e.message);
    } finally {
        // 5. Restore UI Button State
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = "Add Assignment";
        }
    }
}

async function deleteSystemRecord(collectionName, docId) {
    if (confirm("Are you sure you want to permanently delete this assignment?")) {
        try {
            if (collectionName === "system_quizzes") {
                // Fetch document to obtain assignment title
                let examTitle = "";
                let examSubject = "";
                try {
                    const docRef = doc(db, "system_quizzes", docId);
                    const docSnap = await getDoc(docRef);
                    if (docSnap.exists()) {
                        const d = docSnap.data();
                        examTitle = (d.name || "").trim();
                        examSubject = (d.subject || "").trim();
                    }
                } catch (e) {}

                // Delete system_quizzes document
                await deleteDoc(doc(db, "system_quizzes", docId));

                // Also delete any other auto-generated system_quizzes entries for this assignment
                if (examTitle) {
                    const safeTitle = examTitle.replace(/[^a-zA-Z0-9_-]/g, "_");
                    const altDocIds = [`offline_${safeTitle}`, `gclass_${safeTitle}`, `offline_${examTitle}`, `gclass_${examTitle}`];
                    altDocIds.forEach(altId => {
                        if (altId !== docId) {
                            deleteDoc(doc(db, "system_quizzes", altId)).catch(() => {});
                        }
                    });

                    // Remove all associated student score records in exam_scores and legacy scores
                    const allScores = await getDocs(collection(db, "exam_scores"));
                    const deletePromises = [];
                    allScores.forEach(sDoc => {
                        const sData = sDoc.data();
                        const sTitle = (sData.examName || sData.quizName || "").trim().toLowerCase();
                        const sSubj = (sData.subject || "").trim().toLowerCase();
                        if (sTitle === examTitle.toLowerCase() && (!examSubject || sSubj === examSubject.toLowerCase())) {
                            deletePromises.push(deleteDoc(sDoc.ref));
                        }
                    });

                    // Also clean up legacy scores collection
                    try {
                        const legScores = await getDocs(collection(db, "scores"));
                        legScores.forEach(lDoc => {
                            const lTitle = (lDoc.data().quizTitle || lDoc.data().examName || "").trim().toLowerCase();
                            if (lTitle === examTitle.toLowerCase()) {
                                deletePromises.push(deleteDoc(lDoc.ref));
                            }
                        });
                    } catch (le) {}

                    await Promise.all(deletePromises);
                }
            } else {
                await deleteDoc(doc(db, collectionName, docId));
            }

            alert("Assignment deleted successfully.");

            if (typeof window.loadSystemDatabases === "function") {
                await window.loadSystemDatabases();
            }
        } catch (e) {
            alert("Error deleting record: " + e.message);
        }
    }
}

async function loadClassRoster() {
    const subject = document.getElementById('directSubjectSelect').value;
    const selectedClass = document.getElementById('directClassSelect').value;
    const quiz = document.getElementById('directQuizSelect').value;

    if (!subject || !selectedClass || !quiz) {
        alert("Please select Subject, Class, and Quiz first.");
        return;
    }

    try {
        document.getElementById('directScoreContainer').classList.remove('hidden');
        const tbody = document.querySelector('#directScoreTable tbody');
        tbody.innerHTML = "<tr><td colspan='3' style='text-align:center;'>Loading students and scores...</td></tr>";

        // 1. Fetch all students in the class
        const studentsQuery = query(collection(db, "students"), where("studentClass", "==", selectedClass));
        const studentsSnap = await getDocs(studentsQuery);

        if (studentsSnap.empty) {
            tbody.innerHTML = "<tr><td colspan='3' style='text-align:center; color: red;'>No students found in this class.</td></tr>";
            return;
        }

        // 2. Query exam_scores collection for existing entries
        const scoresQuery = query(
            collection(db, "exam_scores"),
            where("studentClass", "==", selectedClass),
            where("subject", "==", subject),
            where("examName", "==", quiz)
        );
        const scoresSnap = await getDocs(scoresQuery);

        // Map existing scores by student code for quick lookup
        const existingScores = {};
        scoresSnap.forEach(docSnap => {
            const data = docSnap.data();
            existingScores[data.studentCode] = data.score;
        });

        // 3. Convert snapshots to array and sort alphabetically by Student Name (A to Z)
        let studentsList = [];
        studentsSnap.forEach(docSnap => {
            studentsList.push({
                id: docSnap.id,
                ...docSnap.data()
            });
        });

        studentsList.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));

        // 4. Render sorted table rows and pre-fill input values
        tbody.innerHTML = "";

        studentsList.forEach(data => {
            const studentCode = data.id;
            const currentScore = existingScores[studentCode] !== undefined ? existingScores[studentCode] : "";

            tbody.innerHTML += `
                <tr>
                    <td><strong>${studentCode}</strong></td>
                    <td>${data.studentName}</td>
                    <td>
                        <input type="number" 
                               class="direct-score-input" 
                               data-code="${studentCode}" 
                               data-name="${data.studentName}" 
                               value="${currentScore}" 
                               placeholder="Score" 
                               style="width: 100px; margin: 0; padding: 6px;">
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Error loading roster:", e);
        alert("Error loading class roster: " + e.message);
    }
}

async function saveDirectScores() {
    const subject = document.getElementById('directSubjectSelect').value;
    const studentClass = document.getElementById('directClassSelect').value;
    const quiz = document.getElementById('directQuizSelect').value;

    if (!subject || !studentClass || !quiz) {
        alert("Please select a Subject, Class, and Quiz before saving.");
        return;
    }

    const scoreInputs = document.querySelectorAll('.direct-score-input');
    const saveBtn = document.getElementById('saveDirectScoresBtn');
    const originalText = saveBtn ? saveBtn.innerText : "Save All Scores to Ledger";
    let savedCount = 0;

    try {
        if (saveBtn) {
            saveBtn.innerText = "Saving to Ledger...";
            saveBtn.disabled = true;
        }

        // Lookup Quiz Type
        let resolvedType = "Quiz";
        try {
            const qSnap = await getDocs(query(collection(db, "system_quizzes"), where("name", "==", quiz)));
            if (!qSnap.empty && qSnap.docs[0].data().type) {
                resolvedType = qSnap.docs[0].data().type;
            } else {
                const lower = quiz.toLowerCase();
                if (lower.includes("review")) resolvedType = "Review";
                else if (lower.includes("homework") || lower.includes("hw")) resolvedType = "Homework";
                else if (lower.includes("exercise")) resolvedType = "Exercise";
                else if (lower.includes("final") || lower.includes("exam") || lower.includes("midterm")) resolvedType = "Final Test";
                else if (lower.includes("project")) resolvedType = "Project";
                else if (lower.includes("skill")) resolvedType = "Skill";
            }
        } catch (te) {
            console.warn(te);
        }

        for (const input of scoreInputs) {
            const scoreValue = input.value;

            if (scoreValue !== "") {
                const studentCode = input.getAttribute('data-code');
                const studentName = input.getAttribute('data-name');

                const customDocId = `${studentCode}_${subject}_${quiz}`.replace(/[^a-zA-Z0-9_-]/g, "_");

                // Save directly to the unified "exam_scores" collection
                await setDoc(doc(db, "exam_scores", customDocId), {
                    studentCode: studentCode,
                    studentName: studentName,
                    subject: subject,
                    studentClass: studentClass,
                    examName: quiz,     // Key used across exam_scores
                    quizName: quiz,     // Key kept for compatibility
                    type: resolvedType, // Type: Exercise, Homework, Quiz, Review, Final Test, Project, Skill
                    score: Number(scoreValue),
                    updatedAt: new Date()
                }, { merge: true });

                savedCount++;
            }
        }

        alert(`Successfully saved/updated ${savedCount} score(s)!`);

    } catch (error) {
        console.error("Error saving scores: ", error);
        alert("An error occurred while saving: " + error.message);
    } finally {
        if (saveBtn) {
            saveBtn.innerText = originalText;
            saveBtn.disabled = false;
        }
    }
}

// --- AUTO-SYNC LEGACY SCORES TO EXAM_SCORES ---
async function syncScoresToExamScores(specificQuiz = null, specificSubject = null, specificClass = null) {
    try {
        let scoresSnap;
        if (specificQuiz) {
            scoresSnap = await getDocs(query(collection(db, "scores"), where("quizTitle", "==", specificQuiz)));
            if (scoresSnap.empty) {
                scoresSnap = await getDocs(query(collection(db, "scores"), where("examName", "==", specificQuiz)));
            }
        } else {
            scoresSnap = await getDocs(collection(db, "scores"));
        }

        if (scoresSnap.empty) return 0;

        // Fetch Quizzes for subject/type mapping
        const quizzesSnap = await getDocs(collection(db, "quizzes"));
        const quizSubjectMap = {};
        const quizTypeMap = {};
        quizzesSnap.forEach(d => {
            const data = d.data();
            const title = (data.title || data.quizName || '').trim();
            if (title) {
                if (data.subject) quizSubjectMap[title.toLowerCase()] = data.subject;
                if (data.type) quizTypeMap[title.toLowerCase()] = data.type;
            }
        });

        // Fetch offline system_quizzes too
        try {
            const sysQuizzesSnap = await getDocs(collection(db, "system_quizzes"));
            sysQuizzesSnap.forEach(d => {
                const data = d.data();
                const title = (data.name || '').trim();
                if (title) {
                    if (data.subject && !quizSubjectMap[title.toLowerCase()]) quizSubjectMap[title.toLowerCase()] = data.subject;
                    if (data.type && !quizTypeMap[title.toLowerCase()]) quizTypeMap[title.toLowerCase()] = data.type;
                }
            });
        } catch (e) { }

        // Fetch Students for class lookup
        const studentsSnap = await getDocs(collection(db, "students"));
        const studentClassMap = {};
        const studentNameMap = {};
        studentsSnap.forEach(d => {
            const data = d.data();
            const code = (data.code || d.id || '').toString().toUpperCase();
            if (code) {
                studentClassMap[code] = data.studentClass || data.class || data.Class || 'Grade 9A';
                studentNameMap[code] = data.studentName || data.name;
            }
        });

        let syncedCount = 0;
        for (const docSnap of scoresSnap.docs) {
            const data = docSnap.data();
            const studentCode = (data.studentCode || docSnap.id.split('_')[0] || '').toString().trim();
            const quizTitle = (data.quizTitle || data.examName || specificQuiz || '').toString().trim();
            const scoreVal = parseFloat(data.score);

            if (!studentCode || !quizTitle || isNaN(scoreVal)) continue;

            const subject = data.subject || quizSubjectMap[quizTitle.toLowerCase()] || specificSubject || "English";
            const studentClass = data.studentClass || data.targetClass || studentClassMap[studentCode.toUpperCase()] || specificClass || "Grade 9A";
            const studentName = data.studentName || studentNameMap[studentCode.toUpperCase()] || "Student";
            const resolvedType = data.type || quizTypeMap[quizTitle.toLowerCase()] || resolveQuizType(quizTitle);

            const customDocId = `${studentCode}_${subject}_${quizTitle}`.replace(/[^a-zA-Z0-9_-]/g, "_");

            await setDoc(doc(db, "exam_scores", customDocId), {
                studentCode: studentCode,
                studentName: studentName,
                subject: subject,
                studentClass: studentClass,
                examName: quizTitle,
                quizName: quizTitle,
                type: resolvedType,
                score: Number(scoreVal),
                updatedAt: new Date()
            }, { merge: true });

            syncedCount++;
        }
        return syncedCount;
    } catch (e) {
        console.warn("Auto-sync scores notice:", e);
        return 0;
    }
}
window.syncScoresToExamScores = syncScoresToExamScores;

let currentLedgerResults = [];
let currentLedgerMeta = { subject: '', studentClass: '', quiz: '', sortOption: '' };

function renderLedgerRows(tbody, ledgerResults, sortOption, selectedQuiz) {
    const selectedSubject = document.getElementById('ledgerSubjectSelect')?.value || '';
    const selectedClass = document.getElementById('ledgerClassSelect')?.value || '';
    
    currentLedgerResults = ledgerResults ? [...ledgerResults] : [];
    currentLedgerMeta = {
        subject: selectedSubject,
        studentClass: selectedClass,
        quiz: selectedQuiz,
        sortOption: sortOption
    };

    tbody.innerHTML = "";
    ledgerResults.sort((a, b) => {
        if (sortOption === 'score_desc') return (Number(b.score) || 0) - (Number(a.score) || 0);
        if (sortOption === 'score_asc') return (Number(a.score) || 0) - (Number(b.score) || 0);
        return (a.studentName || '').localeCompare(b.studentName || '');
    });

    ledgerResults.forEach(data => {
        tbody.innerHTML += `
            <tr>
                <td>${data.examName || data.quizName || selectedQuiz}</td>
                <td>${data.subject || '-'}</td>
                <td>${data.studentName}</td>
                <td><strong>${data.studentClass}</strong></td>
                <td><strong>${data.studentCode}</strong></td>
                <td><strong style="color: #28a745;">${data.score}</strong></td>
                <td>
                    <button class="delete-btn" onclick="deleteStudentScore('${data.id}')">Delete</button>
                </td>
            </tr>
        `;
    });
}

let isScoreExporting = false;

async function exportChosenScoreToExcel() {
    if (isScoreExporting) return;
    isScoreExporting = true;

    const selectedSubject = document.getElementById('ledgerSubjectSelect')?.value || '';
    const selectedClass = document.getElementById('ledgerClassSelect')?.value || '';
    const selectedQuiz = document.getElementById('ledgerQuizSelect')?.value || '';
    const sortOption = document.getElementById('ledgerSortSelect')?.value || 'name_asc';

    const defaultBtnHtml = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Download Excel</span>
    `;

    const exportBtn1 = document.getElementById('exportScoreExcelBtn');
    const exportBtn2 = document.getElementById('exportScoreTableExcelBtn');

    if (!selectedSubject || !selectedClass || !selectedQuiz) {
        alert("Please choose Subject, Class, and Quiz / Review first to download scores as Excel.");
        isScoreExporting = false;
        return;
    }

    if (typeof XLSX === 'undefined') {
        alert("Excel export library (SheetJS) is not loaded. Please refresh the page and try again.");
        isScoreExporting = false;
        return;
    }

    try {
        if (exportBtn1) {
            exportBtn1.disabled = true;
            exportBtn1.innerHTML = `<span>Exporting...</span>`;
        }
        if (exportBtn2) {
            exportBtn2.disabled = true;
            exportBtn2.innerHTML = `<span>Exporting...</span>`;
        }

        let records = [];

        // Check if data is already loaded in memory for the same filters
        if (currentLedgerResults && currentLedgerResults.length > 0 &&
            currentLedgerMeta.subject === selectedSubject &&
            currentLedgerMeta.studentClass === selectedClass &&
            currentLedgerMeta.quiz === selectedQuiz) {
            records = [...currentLedgerResults];
        } else {
            // Query Firestore directly
            let q = query(collection(db, "exam_scores"),
                where("subject", "==", selectedSubject),
                where("studentClass", "==", selectedClass),
                where("examName", "==", selectedQuiz)
            );
            let snap = await getDocs(q);

            if (snap.empty) {
                await syncScoresToExamScores(selectedQuiz, selectedSubject, selectedClass);
                snap = await getDocs(q);
            }

            if (snap.empty) {
                const fallbackQ = query(collection(db, "exam_scores"),
                    where("subject", "==", selectedSubject),
                    where("studentClass", "==", selectedClass),
                    where("quizName", "==", selectedQuiz)
                );
                snap = await getDocs(fallbackQ);
            }

            if (snap.empty) {
                const broadQ = query(collection(db, "exam_scores"), where("examName", "==", selectedQuiz));
                const broadSnap = await getDocs(broadQ);
                broadSnap.forEach(docSnap => {
                    const d = docSnap.data();
                    const normSubj = (d.subject || '').trim().toLowerCase();
                    const normClass = (d.studentClass || '').trim().toLowerCase();
                    if ((normSubj === selectedSubject.toLowerCase() || !selectedSubject) &&
                        (normClass === selectedClass.toLowerCase() || !selectedClass)) {
                        records.push({ id: docSnap.id, ...d });
                    }
                });
            } else {
                snap.forEach(docSnap => {
                    records.push({ id: docSnap.id, ...docSnap.data() });
                });
            }
        }

        if (!records || records.length === 0) {
            alert("No score records found for this Subject, Class, and Quiz combination.");
            return;
        }

        // Sort records
        records.sort((a, b) => {
            if (sortOption === 'score_desc') return (Number(b.score) || 0) - (Number(a.score) || 0);
            if (sortOption === 'score_asc') return (Number(a.score) || 0) - (Number(b.score) || 0);
            return (a.studentName || '').localeCompare(b.studentName || '');
        });

        // Compute summary statistics
        const totalStudents = records.length;
        const scores = records.map(r => Number(r.score) || 0);
        const sumScores = scores.reduce((sum, s) => sum + s, 0);
        const avgScore = totalStudents > 0 ? (sumScores / totalStudents).toFixed(1) : '0';
        const maxScore = totalStudents > 0 ? Math.max(...scores) : 0;
        const minScore = totalStudents > 0 ? Math.min(...scores) : 0;

        // Build Excel Sheet Rows (Array of Arrays)
        const rows = [
            ["MITRA KASIH SCHOOL - SCORE REPORT"],
            [`Exam / Quiz: ${selectedQuiz}`, "", `Subject: ${selectedSubject}`, "", `Class: ${selectedClass}`],
            [`Export Date: ${new Date().toLocaleDateString('en-GB')}`, "", `Total Students: ${totalStudents}`, "", `Average: ${avgScore}`, `Highest: ${maxScore}`, `Lowest: ${minScore}`],
            [],
            ["NO", "STUDENT NAME", "STUDENT CODE", "CLASS", "SUBJECT", "EXAM / QUIZ", "SCORE"]
        ];

        records.forEach((r, idx) => {
            rows.push([
                idx + 1,
                r.studentName || '',
                r.studentCode || '',
                r.studentClass || selectedClass,
                r.subject || selectedSubject,
                r.examName || r.quizName || selectedQuiz,
                Number(r.score) || 0
            ]);
        });

        rows.push([]);
        rows.push(["STATISTICS SUMMARY", "", "", "", "", "", ""]);
        rows.push(["Total Students", totalStudents]);
        rows.push(["Average Score", Number(avgScore)]);
        rows.push(["Highest Score", maxScore]);
        rows.push(["Lowest Score", minScore]);

        const ws = XLSX.utils.aoa_to_sheet(rows);

        // Column widths formatting
        ws['!cols'] = [
            { wch: 6 },  // NO
            { wch: 28 }, // STUDENT NAME
            { wch: 16 }, // STUDENT CODE
            { wch: 14 }, // CLASS
            { wch: 18 }, // SUBJECT
            { wch: 30 }, // EXAM / QUIZ
            { wch: 12 }  // SCORE
        ];

        const wb = XLSX.utils.book_new();
        const safeSheetName = (selectedQuiz || 'Score_Report').substring(0, 31).replace(/[:\\/?*\[\]]/g, '_');
        XLSX.utils.book_append_sheet(wb, ws, safeSheetName);

        const safeSubject = selectedSubject.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeClass = selectedClass.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeQuiz = selectedQuiz.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `Score_${safeSubject}_${safeClass}_${safeQuiz}.xlsx`;

        XLSX.writeFile(wb, fileName);

    } catch (err) {
        console.error("Error downloading score Excel:", err);
        alert("Failed to export Excel file: " + err.message);
    } finally {
        isScoreExporting = false;
        if (exportBtn1) {
            exportBtn1.disabled = false;
            exportBtn1.innerHTML = defaultBtnHtml;
        }
        if (exportBtn2) {
            exportBtn2.disabled = false;
            exportBtn2.innerHTML = defaultBtnHtml;
        }
    }
}
window.exportChosenScoreToExcel = exportChosenScoreToExcel;

async function viewScoreLedger() {
    const selectedSubject = document.getElementById('ledgerSubjectSelect')?.value;
    const selectedClass = document.getElementById('ledgerClassSelect')?.value;
    const selectedQuiz = document.getElementById('ledgerQuizSelect')?.value;
    const sortOption = document.getElementById('ledgerSortSelect')?.value || 'name_asc';

    if (!selectedSubject || !selectedClass || !selectedQuiz) {
        alert("Please select Subject, Class, and Quiz/Review to view the ledger.");
        return;
    }

    const viewBtn = document.getElementById('viewLedgerBtn');

    try {
        if (viewBtn) {
            viewBtn.innerText = "Loading...";
            viewBtn.disabled = true;
        }

        const tableContainer = document.getElementById('scoreLedgerContainer');
        if (tableContainer) tableContainer.style.display = 'block';

        const tbody = document.getElementById('manageScoreTbody');
        tbody.innerHTML = "<tr><td colspan='7' style='text-align:center;'>Fetching scores...</td></tr>";

        // Query unified exam_scores collection filtering by Subject, Class, and Exam
        let q = query(collection(db, "exam_scores"),
            where("subject", "==", selectedSubject),
            where("studentClass", "==", selectedClass),
            where("examName", "==", selectedQuiz)
        );

        let snap = await getDocs(q);

        // If empty, auto-sync from legacy "scores" collection
        if (snap.empty) {
            await syncScoresToExamScores(selectedQuiz, selectedSubject, selectedClass);
            snap = await getDocs(q);
        }

        // Fallback: also check by quizName field
        if (snap.empty) {
            const fallbackQ = query(collection(db, "exam_scores"),
                where("subject", "==", selectedSubject),
                where("studentClass", "==", selectedClass),
                where("quizName", "==", selectedQuiz)
            );
            snap = await getDocs(fallbackQ);
        }

        // Broad fallback: match examName and filter case-insensitively in JS
        if (snap.empty) {
            const broadQ = query(collection(db, "exam_scores"), where("examName", "==", selectedQuiz));
            const broadSnap = await getDocs(broadQ);
            let ledgerResults = [];
            broadSnap.forEach(docSnap => {
                const d = docSnap.data();
                const normSubj = (d.subject || '').trim().toLowerCase();
                const normClass = (d.studentClass || '').trim().toLowerCase();
                if ((normSubj === selectedSubject.toLowerCase() || !selectedSubject) &&
                    (normClass === selectedClass.toLowerCase() || !selectedClass)) {
                    ledgerResults.push({ id: docSnap.id, ...d });
                }
            });

            if (ledgerResults.length > 0) {
                renderLedgerRows(tbody, ledgerResults, sortOption, selectedQuiz);
                return;
            }
        }

        tbody.innerHTML = "";

        if (snap.empty) {
            tbody.innerHTML = "<tr><td colspan='7' style='text-align:center; color: red;'>No scores found for this Subject, Class, and Quiz combination.</td></tr>";
            return;
        }

        let ledgerResults = [];
        snap.forEach(docSnap => {
            ledgerResults.push({ id: docSnap.id, ...docSnap.data() });
        });

        renderLedgerRows(tbody, ledgerResults, sortOption, selectedQuiz);

    } catch (error) {
        console.error("Error loading ledger: ", error);
        alert("An error occurred while loading the ledger: " + error.message);
    } finally {
        if (viewBtn) {
            viewBtn.innerText = "View Table";
            viewBtn.disabled = false;
        }
    }
}

// --- POINTS MODAL LOGIC ---
window.openPointModal = function (code, name) {
    document.getElementById('modalStudentCode').value = code;
    document.getElementById('pointModalStudent').innerText = `Student: ${name} (${code})`;
    document.getElementById('modalPointValue').value = '';
    document.getElementById('modalPointReason').value = '';

    const modal = document.getElementById('pointModal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
};

window.closePointModal = function () {
    const modal = document.getElementById('pointModal');
    modal.classList.add('hidden');
    modal.style.display = 'none';
};

window.submitModalPoint = async function () {
    const code = document.getElementById('modalStudentCode').value;
    const amount = parseFloat(document.getElementById('modalPointValue').value);
    const reason = document.getElementById('modalPointReason').value.trim();

    if (!code || isNaN(amount) || !reason) {
        alert("Please provide both a point amount and a reason.");
        return;
    }

    try {
        const studentSnap = await getDoc(doc(db, "students", code));
        let targetClass = 'N/A';
        let studentName = code;

        if (studentSnap.exists()) {
            const sData = studentSnap.data();
            targetClass = sData.studentClass || sData.Class || sData.class || 'N/A';
            studentName = sData.studentName || code;
        }

        await addDoc(collection(db, "student_points"), {
            studentCode: code,
            studentName: studentName,
            studentClass: targetClass,
            reason: reason,
            points: amount,
            timestamp: new Date()
        });

        const sign = amount > 0 ? '+' : '';
        alert(`Successfully recorded ${sign}${amount} points.`);

        closePointModal();
        loadPointsTable(); // Refresh the ledger immediately
    } catch (e) {
        alert("Error adjusting points: " + e.message);
    }
};



// Function to toggle code visibility in the Points Ledger
window.togglePtCodeVisibility = function (studentId) {
    const span = document.getElementById(`pt-code-${studentId}`);
    if (!span) return;

    if (span.innerText === '•••••') {
        span.innerText = studentId; // Show real code
        span.style.letterSpacing = 'normal'; // Reset spacing
    } else {
        span.innerText = '•••••'; // Hide code
        span.style.letterSpacing = '2px'; // Add spacing for dots
    }
};

let uniquePastReasons = [];

// 1. Core Data Aggregator for Behavior Tab
async function refreshBehaviorTabLedgers() {
    try {
        const pointsSnap = await getDocs(collection(db, "student_points"));

        // Variables for tables
        const studentTotals = {};
        const reasonStats = {};
        const reasonsSet = new Set();

        pointsSnap.forEach(doc => {
            const data = doc.data();
            const pt = parseFloat(data.points) || 0;
            const reasonRaw = (data.reason || "Unknown").trim();
            const rKey = reasonRaw.toLowerCase();

            // Build student totals for the full ledger
            if (!studentTotals[data.studentCode]) {
                studentTotals[data.studentCode] = {
                    code: data.studentCode,
                    name: data.studentName,
                    sClass: data.studentClass,
                    total: 0
                };
            }
            studentTotals[data.studentCode].total += pt;

            // Build reason statistics
            if (reasonRaw) {
                reasonsSet.add(reasonRaw); // For autocomplete
                if (!reasonStats[rKey]) {
                    reasonStats[rKey] = { text: reasonRaw, posPts: 0, negPts: 0, count: 0 };
                }
                reasonStats[rKey].count++;
                if (pt > 0) reasonStats[rKey].posPts += pt;
                if (pt < 0) reasonStats[rKey].negPts += Math.abs(pt);
            }
        });

        uniquePastReasons = Array.from(reasonsSet);

        // --- Render Full Ledger in Behavior Tab (without student code column) ---
        const ledgerTbody = document.querySelector("#behaviorTabPointsTable tbody");
        if (ledgerTbody) {
            ledgerTbody.innerHTML = "";
            Object.values(studentTotals)
                .sort((a, b) => b.total - a.total)
                .forEach(info => {
                    const color = info.total > 0 ? '#28a745' : (info.total < 0 ? '#dc3545' : '#333');
                    const sign = info.total > 0 ? '+' : '';
                    const safeName = (info.name || '').replace(/'/g, "\\'");

                    ledgerTbody.innerHTML += `<tr>
                        <td><strong>${info.name || 'N/A'}</strong></td>
                        <td><strong>${info.sClass || 'N/A'}</strong></td>
                        <td><strong style="color: ${color};">${sign}${info.total}</strong></td>
                        <td>
                            <div class="kebab-menu">
                                <button class="kebab-btn" onclick="toggleMenu(event, 'bhv-${info.code}')">⋮</button>
                                <div id="menu-bhv-${info.code}" class="dropdown-menu">
                                    <button class="dropdown-item" onclick="openBehaviorHistoryModal('${info.code}', '${safeName}')">View History</button>
                                </div>
                            </div>
                        </td>
                    </tr>`;
                });
        }

        // --- Render Behavior Analytics Bar Charts (Chart.js) ---
        renderBehaviorCharts(reasonStats);

    } catch (e) {
        console.error("Error generating behavior stats: ", e);
    }
}

let posChartInstance = null;
let negChartInstance = null;

function renderBehaviorCharts(reasonStats) {
    if (typeof Chart === 'undefined') return;

    const topPos = Object.values(reasonStats)
        .filter(r => r.posPts > 0)
        .sort((a, b) => b.posPts - a.posPts)
        .slice(0, 10);

    const topNeg = Object.values(reasonStats)
        .filter(r => r.negPts > 0)
        .sort((a, b) => b.negPts - a.negPts)
        .slice(0, 10);

    // 1. Positive Chart
    const posCanvas = document.getElementById('positiveReasonsChart');
    if (posCanvas) {
        if (posChartInstance) posChartInstance.destroy();
        posChartInstance = new Chart(posCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: topPos.map(r => r.text),
                datasets: [{
                    label: 'Points Earned (+)',
                    data: topPos.map(r => r.posPts),
                    backgroundColor: 'rgba(16, 185, 129, 0.7)',
                    borderColor: '#10b981',
                    borderWidth: 1,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                    y: { grid: { display: false } }
                }
            }
        });
    }

    // 2. Negative Chart
    const negCanvas = document.getElementById('negativeReasonsChart');
    if (negCanvas) {
        if (negChartInstance) negChartInstance.destroy();
        negChartInstance = new Chart(negCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: topNeg.map(r => r.text),
                datasets: [{
                    label: 'Points Deducted (-)',
                    data: topNeg.map(r => r.negPts),
                    backgroundColor: 'rgba(224, 45, 45, 0.7)',
                    borderColor: '#e02d2d',
                    borderWidth: 1,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                    y: { grid: { display: false } }
                }
            }
        });
    }
}

window.toggleBehaviorCharts = function () {
    const container = document.getElementById('containerBehaviorCharts');
    const btn = document.getElementById('btnToggleBehaviorCharts');
    if (!container || !btn) return;

    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.innerText = 'Hide Diagram';
        btn.style.background = '#64748b';
        if (typeof refreshBehaviorTabLedgers === 'function') refreshBehaviorTabLedgers();
    } else {
        container.classList.add('hidden');
        btn.innerText = 'Show Diagram';
        btn.style.background = 'var(--primary-blue)';
    }
};

// 2. Autocomplete Filter Logic
function setupAutocomplete(inputElement, listElement, dataProvider) {
    inputElement.addEventListener("input", function () {
        const val = this.value;
        listElement.innerHTML = "";
        if (!val) {
            listElement.classList.add("hidden");
            return;
        }

        // dataProvider is a function that returns the array we want to search through
        const dataArray = dataProvider();
        const matches = dataArray.filter(item => item.toLowerCase().includes(val.toLowerCase())).slice(0, 8); // Max 8 results

        if (matches.length > 0) {
            listElement.classList.remove("hidden");
            matches.forEach(match => {
                const div = document.createElement("DIV");
                div.innerHTML = match;
                div.addEventListener("click", function () {
                    inputElement.value = match;
                    listElement.innerHTML = "";
                    listElement.classList.add("hidden");
                });
                listElement.appendChild(div);
            });
        } else {
            listElement.classList.add("hidden");
        }
    });
}

// 3. Initialize the Listeners
document.addEventListener("DOMContentLoaded", () => {
    // Setup Name Autocomplete (Pulling from allStudentsData loaded globally)
    const nameInput = document.getElementById("pointStudentName");
    const nameList = document.getElementById("nameAutocompleteList");
    if (nameInput) {
        setupAutocomplete(nameInput, nameList, () => allStudentsData.map(s => s.studentName));
    }

    // Setup Reason Autocomplete
    const reasonInput = document.getElementById("pointReason");
    const reasonList = document.getElementById("reasonAutocompleteList");
    if (reasonInput) {
        setupAutocomplete(reasonInput, reasonList, () => uniquePastReasons);
    }

    // Close dropdowns when clicking outside
    document.addEventListener("click", function (e) {
        if (nameInput && e.target !== nameInput) nameList.classList.add("hidden");
        if (reasonInput && e.target !== reasonInput) reasonList.classList.add("hidden");
    });

    // Hook into tab click to refresh data
    document.querySelector('[data-tab="tab-manage-behavior"]')?.addEventListener("click", refreshBehaviorTabLedgers);
});

const themeToggleBtn = document.getElementById('themeToggleBtn');
const adminThemeIcon = document.getElementById('adminThemeIcon');
const adminThemeText = document.getElementById('adminThemeText');

// Google Drive Image URLs
const DARK_MODE_ICON_URL = 'https://lh3.googleusercontent.com/d/1N2sZUgBKIQCviZYYm4ibVWCXc4XVhnnh';
const LIGHT_MODE_ICON_URL = 'https://lh3.googleusercontent.com/d/1_NNJ0sMnU6x1pLW1GiV8FmfL9bPccVhd';

function applyAdminTheme(theme) {
    const mobileThemeText = document.getElementById('mobileKebabThemeText');
    if (theme === 'dark') {
        document.body.classList.add('dark-theme');
        if (adminThemeIcon) adminThemeIcon.src = LIGHT_MODE_ICON_URL;
        if (adminThemeText) adminThemeText.innerText = 'Light Mode';
        if (mobileThemeText) mobileThemeText.innerText = 'Light Mode';
    } else {
        document.body.classList.remove('dark-theme');
        if (adminThemeIcon) adminThemeIcon.src = DARK_MODE_ICON_URL;
        if (adminThemeText) adminThemeText.innerText = 'Dark Mode';
        if (mobileThemeText) mobileThemeText.innerText = 'Dark Mode';
    }
}

// Load saved theme state
const savedAdminTheme = localStorage.getItem('appTheme') || 'light';
applyAdminTheme(savedAdminTheme);

// Handle toggle click
themeToggleBtn?.addEventListener('click', () => {
    const isDarkNow = document.body.classList.toggle('dark-theme');
    const newTheme = isDarkNow ? 'dark' : 'light';
    localStorage.setItem('appTheme', newTheme);
    applyAdminTheme(newTheme);
});


// --- 4. FIX CLOSE QUIZ RESULTS MODAL ---
function closeResultsModal() {
    const modal = document.getElementById('quizResultsModal');
    // FIX: Add hidden class back when closing
    modal.classList.add('hidden');
    modal.style.display = 'none';
}
window.viewQuizResults = viewQuizResults;
window.closeResultsModal = closeResultsModal;

// --- 5. PRESERVE STATUS DURING SAVE ---
async function saveQuiz() {
    const title = document.getElementById('quizTitle').value.trim();
    const quizType = document.getElementById('quizTypeSelect')?.value || 'Quiz';
    const selectedClasses = getSelectedQuizClasses();
    const targetClassStr = selectedClasses.includes("All Classes") ? "All Classes" : selectedClasses.join(", ");
    const subject = document.getElementById('quizSubject').value.trim();
    const blocksElements = document.querySelectorAll('.quiz-block');

    if (!title || selectedClasses.length === 0 || blocksElements.length === 0) {
        return alert("Please fill in quiz title, select at least one target class, and add at least one block.");
    }

    const items = [];
    blocksElements.forEach(el => {
        const type = el.dataset.type;

        const imgNode = el.querySelector('.blk-img');
        const imgRaw = imgNode ? imgNode.value.trim() : '';
        const imgUrl = convertDriveUrl(imgRaw);

        const pointsNode = el.querySelector('.blk-points');
        const points = pointsNode ? parseInt(pointsNode.value) || 1 : 0;

        if (type === 'header') {
            const titleText = el.querySelector('.blk-prompt') ? el.querySelector('.blk-prompt').innerText.trim() : '';
            const descText = el.querySelector('.blk-desc') ? el.querySelector('.blk-desc').innerText.trim() : '';
            items.push({ type, text: titleText, description: descText });

        } else if (type === 'mcq') {
            const options = [];
            let selectedCorrectIndex = 0;

            const optionRows = el.querySelectorAll('.options-container .gform-opt-row');
            optionRows.forEach((row) => {
                const input = row.querySelector('.gform-opt-input');
                const radio = row.querySelector('input[type="radio"]');

                if (input && input.value.trim() !== '') {
                    options.push(input.value.trim());
                    // Directly verify if this radio option is selected
                    if (radio && radio.checked) {
                        selectedCorrectIndex = options.length - 1;
                    }
                }
            });

            items.push({
                type,
                prompt: el.querySelector('.blk-prompt').innerText.trim(),
                imageUrl: imgUrl,
                points: points,
                options: options,
                correct: selectedCorrectIndex
            });


        } else if (type === 'fill') {
            items.push({
                type,
                prompt: el.querySelector('.blk-prompt').innerText.trim(),
                imageUrl: imgUrl,
                points: points,
                answers: el.querySelector('.blk-answer').value.trim().toLowerCase().split(',').map(a => a.trim())
            });

        } else if (type === 'essay') {
            items.push({
                type,
                prompt: el.querySelector('.blk-prompt').innerText.trim(),
                imageUrl: imgUrl,
                points: points
            });
        }
    });

    try {
        if (currentEditQuizId) {
            await updateDoc(doc(db, "quizzes", currentEditQuizId), {
                title,
                type: quizType,
                targetClass: targetClassStr,
                targetClassesList: selectedClasses,
                subject,
                items,
                updatedAt: new Date().toISOString()
            });
            alert("Quiz updated successfully!");
            currentEditQuizId = null;
        } else {
            // New quizzes are published with status: 'active' by default
            await addDoc(collection(db, "quizzes"), {
                title,
                type: quizType,
                targetClass: targetClassStr,
                targetClassesList: selectedClasses,
                subject,
                items,
                status: 'active',
                createdAt: new Date().toISOString()
            });
            alert("Quiz published successfully!");
        }

        closeQuizBuilder();
        document.getElementById('quizBlocksContainer').innerHTML = "";
        document.getElementById('quizTitle').value = "";
        loadQuizzesTable();
    } catch (e) {
        alert("Error saving quiz: " + e.message);
    }
}

// --- MCQ DYNAMIC OPTION MANAGEMENT ---
window.addOptionToMCQ = function (btnElement, blockId) {
    const block = btnElement.closest('.quiz-block');
    const optionsContainer = block.querySelector('.options-container');
    if (!optionsContainer) return;

    const currentRows = optionsContainer.querySelectorAll('.gform-opt-row');
    const newIdx = currentRows.length;

    const newRow = document.createElement('div');
    newRow.className = 'gform-opt-row';
    newRow.innerHTML = `
        <input type="radio" name="${blockId}_correct" value="${newIdx}" title="Mark as correct answer" ${newIdx === 0 ? 'checked' : ''}>
        <input type="text" class="gform-opt-input blk-opt${newIdx}" placeholder="Option ${newIdx + 1}" required>
        <button class="icon-btn delete" type="button" title="Remove Option" onclick="this.closest('.gform-opt-row').remove(); window.reindexMCQOptions(this.closest('.quiz-block'))">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
    `;
    optionsContainer.appendChild(newRow);
};

window.reindexMCQOptions = function (block) {
    if (!block) return;
    const rows = block.querySelectorAll('.options-container .gform-opt-row');
    const blockId = block.dataset.blockId || 'block';

    rows.forEach((row, i) => {
        const radio = row.querySelector('input[type="radio"]');
        if (radio) {
            radio.value = i;
            radio.name = `${blockId}_correct`;
        }
    });
};

// --- 3. HELPER TO CREATE MODAL IF NOT PRESENT IN HTML ---
function createQuizResultsModal() {
    let modal = document.getElementById("quizResultsModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "quizResultsModal";
    modal.className = "modal";
    modal.style.cssText = "display:none; position:fixed; z-index:2000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.5); overflow:auto;";

    modal.innerHTML = `
        <div class="modal-content" style="background:var(--card-bg, #fff); margin:5% auto; padding:24px; border-radius:12px; max-width:700px; width:90%; position:relative;">
            <span onclick="document.getElementById('quizResultsModal').style.display='none'" style="position:absolute; right:20px; top:16px; cursor:pointer; font-size:24px; font-weight:bold;">&times;</span>
            <h3 id="quizResultsTitle" style="margin-top:0;">Quiz Results</h3>
            <div style="max-height: 400px; overflow-y: auto; margin-top: 16px;">
                <table id="quizResultsTable" style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="text-align:left; border-bottom:2px solid var(--border-color, #e2e8f0);">
                            <th style="padding:8px;">Student</th>
                            <th style="padding:8px;">Class</th>
                            <th style="padding:8px;">Score</th>
                            <th style="padding:8px;">Action</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    return modal;
}
window.toggleQuizStatus = toggleQuizStatus;

// --- TEACHER MASTER DIRECTORY LOGIC ---

async function loadTeachersDirectory() {
    try {
        const usersSnap = await getDocs(collection(db, "users"));
        const tbody = document.querySelector("#teachersDirectoryTable tbody");
        if (!tbody) return;

        tbody.innerHTML = "";

        let teacherCount = 0;
        usersSnap.forEach((docSnap) => {
            const data = docSnap.data();
            if (data.role === 'teacher') {
                teacherCount++;
                const teacherId = docSnap.id;
                const teacherEmail = data.email || "N/A";

                // Safe check: Only run .split() if data.email is defined
                const fallbackName = data.email ? data.email.split('@')[0] : "Teacher";
                const teacherName = data.name || fallbackName;
                const teacherSubject = data.subject || "Unassigned";

                const safeName = teacherName.replace(/'/g, "\\'");
                const safeSubject = teacherSubject.replace(/'/g, "\\'");

                tbody.innerHTML += `
                    <tr>
                        <td><strong>${teacherName}</strong></td>
                        <td>${teacherEmail}</td>
                        <td><span style="background: #eef2ff; color: var(--primary-blue); padding: 4px 8px; border-radius: 4px; font-weight: 600; font-size: 13px;">${teacherSubject}</span></td>
                        <td>
                            <div class="kebab-menu">
                                <button class="kebab-btn" onclick="toggleMenu(event, 'teacher-${teacherId}')">⋮</button>
                                <div id="menu-teacher-${teacherId}" class="dropdown-menu">
                                    <button class="dropdown-item" onclick="editTeacherSubjectSpecialty('${teacherId}', '${safeName}', '${safeSubject}')">✏️ Edit Subject Specialty</button>
                                    <button class="dropdown-item" onclick="editTeacherProfile('${teacherId}', '${safeName}', '${safeSubject}')">Edit Details</button>
                                    <button class="dropdown-item" onclick="sendTeacherPasswordReset('${teacherEmail}')">Send Password Reset Email</button>
                                    <button class="dropdown-item danger" onclick="deleteTeacherAccount('${teacherId}', '${safeName}')">Delete Account</button>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }
        });

        if (teacherCount === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--text-gray);">No teacher accounts found in database.</td></tr>`;
        }

    } catch (error) {
        console.error("Error loading teachers directory:", error);
    }
}

window.editTeacherSubjectSpecialty = async function (uid, currentName, currentSubject) {
    const promptMsg = `Modify Subject Specialty for ${currentName}:\n(For multiple subjects, separate with commas, e.g., "English G10, English G11, Seni Rupa")`;
    const newSubject = prompt(promptMsg, currentSubject);
    if (newSubject === null) return;

    if (!newSubject.trim()) {
        alert("Subject Specialty cannot be left empty.");
        return;
    }

    try {
        await updateDoc(doc(db, "users", uid), {
            subject: newSubject.trim()
        });

        alert(`Subject specialty updated successfully for ${currentName}!\nAssigned Subjects: ${newSubject.trim()}`);
        loadTeachersDirectory();
        if (typeof window.loadSystemDatabases === "function") {
            window.loadSystemDatabases();
        }
    } catch (e) {
        alert("Error updating subject specialty: " + e.message);
    }
};

window.editTeacherProfile = async function (uid, currentName, currentSubject) {
    const newName = prompt("Modify Teacher Full Name:", currentName);
    if (newName === null) return;

    const newSubject = prompt("Modify Subject Specialty (comma separated for multiple):", currentSubject);
    if (newSubject === null) return;

    if (!newName.trim() || !newSubject.trim()) {
        alert("Teacher Name and Subject cannot be left empty.");
        return;
    }

    try {
        await updateDoc(doc(db, "users", uid), {
            name: newName.trim(),
            subject: newSubject.trim()
        });

        alert("Teacher details updated successfully!");
        loadTeachersDirectory();
        if (typeof window.loadSystemDatabases === "function") {
            window.loadSystemDatabases();
        }
    } catch (e) {
        alert("Error updating teacher record: " + e.message);
    }
};

window.sendTeacherPasswordReset = async function (email) {
    if (!email || email === "N/A") return alert("No valid email address available for this account.");

    if (confirm(`Send a password reset email to ${email}?`)) {
        try {
            await sendPasswordResetEmail(auth, email);
            alert(`Password reset link sent to ${email}. The teacher can follow the link to set a new password.`);
        } catch (e) {
            alert("Error sending reset email: " + e.message);
        }
    }
};

window.deleteTeacherAccount = async function (uid, teacherName) {
    if (confirm(`Are you sure you want to delete teacher account "${teacherName}" from the database?\n(Note: This removes their database record.)`)) {
        try {
            await deleteDoc(doc(db, "users", uid));
            alert("Teacher record deleted successfully.");
            loadTeachersDirectory();
            if (typeof window.loadSystemDatabases === "function") {
                window.loadSystemDatabases();
            }
        } catch (e) {
            alert("Error removing teacher record: " + e.message);
        }
    }
};

// --- SAFE QUIZ FILTERING ---
async function filterDirectQuizzes() {
    const subjectSelect = document.getElementById('directSubjectSelect');
    const classSelect = document.getElementById('directClassSelect');
    const quizSelect = document.getElementById('directQuizSelect');

    if (!quizSelect) return;

    const selectedSubject = subjectSelect ? subjectSelect.value.trim().toLowerCase() : "";
    const selectedClass = classSelect ? classSelect.value.trim().toLowerCase() : "";

    quizSelect.innerHTML = '<option value="">-- Select Quiz --</option>';

    if (!selectedSubject || !selectedClass) return;

    const seenTitles = new Set();

    try {
        // 1. Digital Quizzes
        try {
            const digitalSnap = await getDocs(collection(db, "quizzes"));
            digitalSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.title || data.quizName || "").trim();
                const qSubject = (data.subject || "").trim().toLowerCase();
                const qClass = (data.targetClass || "").trim().toLowerCase();
                const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

                const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject) || qSubject.includes(selectedSubject);
                const matchesClass = !qClass ||
                    qClass === selectedClass ||
                    qClass === "all classes" ||
                    qClass === "all" ||
                    qClass.includes("all classes") ||
                    qClass.includes("all") ||
                    qClass.includes(selectedClass) ||
                    targetList.includes(selectedClass);

                if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                    seenTitles.add(title.toLowerCase());
                    quizSelect.innerHTML += `<option value="${title}">${title} (Digital)</option>`;
                }
            });
        } catch (err) {
            console.warn("Could not read digital quizzes:", err.message);
        }

        // 2. Offline & Classroom Quizzes from system_quizzes
        try {
            const manualSnap = await getDocs(collection(db, "system_quizzes"));
            manualSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.name || "").trim();
                const qSubject = (data.subject || "").trim().toLowerCase();
                const qClass = (data.targetClass || "").trim().toLowerCase();
                const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

                const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject) || qSubject.includes(selectedSubject);
                const matchesClass = !qClass ||
                    qClass === selectedClass ||
                    qClass === "all classes" ||
                    qClass === "all" ||
                    qClass.includes("all classes") ||
                    qClass.includes("all") ||
                    qClass.includes(selectedClass) ||
                    targetList.includes(selectedClass);

                if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                    seenTitles.add(title.toLowerCase());
                    const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom" : "Offline";
                    quizSelect.innerHTML += `<option value="${title}">${title} (${tag})</option>`;
                }
            });
        } catch (err) {
            console.warn("Could not read offline/classroom quizzes:", err.message);
        }

        // 3. Fallback: Synced exam_scores entries
        try {
            const scoresSnap = await getDocs(collection(db, "exam_scores"));
            scoresSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.examName || data.quizName || "").trim();
                const docSubj = (data.subject || "").trim().toLowerCase();
                const docClass = (data.studentClass || "").trim().toLowerCase();

                if (title && (docSubj === selectedSubject || !selectedSubject) && (docClass === selectedClass || !selectedClass)) {
                    if (!seenTitles.has(title.toLowerCase())) {
                        seenTitles.add(title.toLowerCase());
                        const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom" : "Offline";
                        quizSelect.innerHTML += `<option value="${title}">${title} (${tag})</option>`;
                    }
                }
            });
        } catch (err) { }

    } catch (e) {
        console.error("Error filtering direct quizzes:", e.message);
    }
}

// --- DYNAMIC QUIZ FILTERING FOR LEDGER ---
async function filterLedgerQuizzes() {
    const subjectSelect = document.getElementById('ledgerSubjectSelect');
    const classSelect = document.getElementById('ledgerClassSelect');
    const quizSelect = document.getElementById('ledgerQuizSelect');

    if (!quizSelect) return;

    const selectedSubject = subjectSelect ? subjectSelect.value.trim().toLowerCase() : "";
    const selectedClass = classSelect ? classSelect.value.trim().toLowerCase() : "";

    quizSelect.innerHTML = '<option value="">-- Choose a Quiz / Review --</option>';

    if (!selectedSubject || !selectedClass) return;

    const seenTitles = new Set();

    try {
        // 1. Digital Quizzes
        try {
            const digitalSnap = await getDocs(collection(db, "quizzes"));
            digitalSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.title || data.quizName || "").trim();
                const qSubject = (data.subject || "").trim().toLowerCase();
                const qClass = (data.targetClass || "").trim().toLowerCase();
                const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

                const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject) || qSubject.includes(selectedSubject);
                const matchesClass = !qClass ||
                    qClass === selectedClass ||
                    qClass === "all classes" ||
                    qClass === "all" ||
                    qClass.includes("all classes") ||
                    qClass.includes("all") ||
                    qClass.includes(selectedClass) ||
                    targetList.includes(selectedClass);

                if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                    seenTitles.add(title.toLowerCase());
                    quizSelect.innerHTML += `<option value="${title}">${title} (Digital)</option>`;
                }
            });
        } catch (err) {
            console.warn("Could not read digital quizzes:", err.message);
        }

        // 2. Offline & Classroom Quizzes from system_quizzes
        try {
            const manualSnap = await getDocs(collection(db, "system_quizzes"));
            manualSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.name || "").trim();
                const qSubject = (data.subject || "").trim().toLowerCase();
                const qClass = (data.targetClass || "").trim().toLowerCase();
                const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

                const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject) || qSubject.includes(selectedSubject);
                const matchesClass = !qClass ||
                    qClass === selectedClass ||
                    qClass === "all classes" ||
                    qClass === "all" ||
                    qClass.includes("all classes") ||
                    qClass.includes("all") ||
                    qClass.includes(selectedClass) ||
                    targetList.includes(selectedClass);

                if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                    seenTitles.add(title.toLowerCase());
                    const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom" : "Offline";
                    quizSelect.innerHTML += `<option value="${title}">${title} (${tag})</option>`;
                }
            });
        } catch (err) {
            console.warn("Could not read offline/classroom quizzes:", err.message);
        }

        // 3. Fallback: Synced exam_scores entries directly
        try {
            const scoresSnap = await getDocs(collection(db, "exam_scores"));
            scoresSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.examName || data.quizName || "").trim();
                const docSubj = (data.subject || "").trim().toLowerCase();
                const docClass = (data.studentClass || "").trim().toLowerCase();

                if (title && (docSubj === selectedSubject || !selectedSubject) && (docClass === selectedClass || !selectedClass)) {
                    if (!seenTitles.has(title.toLowerCase())) {
                        seenTitles.add(title.toLowerCase());
                        const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom" : "Offline";
                        quizSelect.innerHTML += `<option value="${title}">${title} (${tag})</option>`;
                    }
                }
            });
        } catch (err) { }

    } catch (e) {
        console.error("Error filtering ledger quizzes:", e.message);
    }
}

// --- DYNAMIC QUIZ FILTERING FOR BULK TEMPLATE ---
async function filterBulkQuizzes() {
    const subjectSelect = document.getElementById('bulkSubjectSelect');
    const classSelect = document.getElementById('bulkClassSelect');
    const quizSelect = document.getElementById('bulkQuizSelect');

    if (!quizSelect) return;

    const selectedSubject = subjectSelect ? subjectSelect.value.trim().toLowerCase() : "";
    const selectedClass = classSelect ? classSelect.value.trim().toLowerCase() : "";

    quizSelect.innerHTML = '<option value="">-- Select Quiz --</option>';

    if (!selectedSubject || !selectedClass) return;

    const seenTitles = new Set();

    try {
        // Fetch Digital Quizzes
        const digitalSnap = await getDocs(collection(db, "quizzes"));
        digitalSnap.forEach(docSnap => {
            const data = docSnap.data();
            const title = (data.title || data.quizName || "").trim();
            const qSubject = (data.subject || "").trim().toLowerCase();
            const qClass = (data.targetClass || "").trim().toLowerCase();
            const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

            const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject);
            const matchesClass = !qClass ||
                qClass === selectedClass ||
                qClass === "all classes" ||
                qClass === "all" ||
                qClass.includes("all classes") ||
                qClass.includes("all") ||
                qClass.includes(selectedClass) ||
                targetList.includes(selectedClass);

            if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                seenTitles.add(title.toLowerCase());
                quizSelect.innerHTML += `<option value="${title}">${title} (Digital)</option>`;
            }
        });

        // Fetch Offline & Classroom Quizzes
        const manualSnap = await getDocs(collection(db, "system_quizzes"));
        manualSnap.forEach(docSnap => {
            const data = docSnap.data();
            const title = (data.name || "").trim();
            const qSubject = (data.subject || "").trim().toLowerCase();
            const qClass = (data.targetClass || "").trim().toLowerCase();
            const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

            const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject);
            const matchesClass = !qClass ||
                qClass === selectedClass ||
                qClass === "all classes" ||
                qClass === "all" ||
                qClass.includes("all classes") ||
                qClass.includes("all") ||
                qClass.includes(selectedClass) ||
                targetList.includes(selectedClass);

            if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                seenTitles.add(title.toLowerCase());
                const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom" : "Offline";
                quizSelect.innerHTML += `<option value="${title}">${title} (${tag})</option>`;
            }
        });

        // Fallback: exam_scores
        try {
            const scoresSnap = await getDocs(collection(db, "exam_scores"));
            scoresSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.examName || data.quizName || "").trim();
                const docSubj = (data.subject || "").trim().toLowerCase();
                const docClass = (data.studentClass || "").trim().toLowerCase();

                if (title && (docSubj === selectedSubject || !selectedSubject) && (docClass === selectedClass || !selectedClass)) {
                    if (!seenTitles.has(title.toLowerCase())) {
                        seenTitles.add(title.toLowerCase());
                        const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom" : "Offline";
                        quizSelect.innerHTML += `<option value="${title}">${title} (${tag})</option>`;
                    }
                }
            });
        } catch (err) { }
    } catch (e) {
        console.error("Error filtering bulk quizzes:", e.message);
    }
}

// --- AUTOMATED EXCEL TEMPLATE GENERATOR ---
async function downloadScoreTemplate() {
    const subject = document.getElementById('bulkSubjectSelect')?.value;
    const studentClass = document.getElementById('bulkClassSelect')?.value;
    const quiz = document.getElementById('bulkQuizSelect')?.value;

    if (!subject || !studentClass || !quiz) {
        alert("Please select a Subject, Class, and Quiz before downloading the template.");
        return;
    }

    const downloadBtn = document.getElementById('downloadTemplateBtn');

    try {
        if (downloadBtn) {
            downloadBtn.innerText = "Generating...";
            downloadBtn.disabled = true;
        }

        // 1. Fetch students belonging to target class
        const studentsQuery = query(collection(db, "students"), where("studentClass", "==", studentClass));
        const studentsSnap = await getDocs(studentsQuery);

        if (studentsSnap.empty) {
            alert(`No students found registered under class "${studentClass}".`);
            return;
        }

        // 2. Query existing exam scores to pre-fill current grades if available
        const scoresQuery = query(
            collection(db, "exam_scores"),
            where("studentClass", "==", studentClass),
            where("subject", "==", subject),
            where("examName", "==", quiz)
        );
        const scoresSnap = await getDocs(scoresQuery);
        const existingScores = {};
        scoresSnap.forEach(docSnap => {
            const data = docSnap.data();
            existingScores[data.studentCode] = data.score;
        });

        // 3. Construct clean 2D array: Metadata on top rows, followed by compact student table
        const wsData = [
            ["Subject:", subject],
            ["Class:", studentClass],
            ["Exam Name:", quiz],
            [""], // Empty separator row
            ["No", "Student Code", "Student Name", "Score"]
        ];

        let sortedStudents = [];
        studentsSnap.forEach(docSnap => {
            const sData = docSnap.data();
            const code = docSnap.id;
            const currentScore = existingScores[code] !== undefined ? existingScores[code] : "";
            sortedStudents.push({
                code: code,
                name: sData.studentName || "",
                score: currentScore
            });
        });

        // Sort alphabetically by Student Name (A-Z)
        sortedStudents.sort((a, b) => a.name.localeCompare(b.name));

        sortedStudents.forEach((st, idx) => {
            wsData.push([
                idx + 1,
                st.code,
                st.name,
                st.score !== undefined && st.score !== "" ? st.score : ""
            ]);
        });

        // 4. Generate worksheet using SheetJS
        const worksheet = XLSX.utils.aoa_to_sheet(wsData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Scores");

        // Format column widths for clarity
        worksheet["!cols"] = [
            { wch: 6 },  // No
            { wch: 16 }, // Student Code
            { wch: 32 }, // Student Name
            { wch: 12 }  // Score
        ];

        // 5. Trigger download file
        const fileName = `ScoreTemplate_${studentClass}_${subject}_${quiz}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        XLSX.writeFile(workbook, `${fileName}.xlsx`);

    } catch (err) {
        console.error("Error generating template:", err);
        alert("Failed to generate Excel template: " + err.message);
    } finally {
        if (downloadBtn) {
            downloadBtn.innerText = "Download Template";
            downloadBtn.disabled = false;
        }
    }
}

window.openBehaviorHistoryModal = async function (studentCode, studentName) {
    const modal = document.getElementById('behaviorHistoryModal');
    const title = document.getElementById('historyModalTitle');
    const tbody = document.getElementById('historyDetailTbody');

    if (!modal || !tbody) return;

    title.innerText = `Behavior History: ${studentName} (${studentCode})`;
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">Loading logs...</td></tr>`;

    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    try {
        const q = query(collection(db, "student_points"), where("studentCode", "==", studentCode));
        const snap = await getDocs(q);

        tbody.innerHTML = "";

        if (snap.empty) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--text-gray);">No behavior entries recorded for this student.</td></tr>`;
            return;
        }

        let entries = [];
        snap.forEach(docSnap => {
            entries.push({ docId: docSnap.id, ...docSnap.data() });
        });

        // Sort newest entries first
        entries.sort((a, b) => {
            const tA = a.timestamp ? (a.timestamp.seconds ? a.timestamp.seconds * 1000 : new Date(a.timestamp).getTime()) : 0;
            const tB = b.timestamp ? (b.timestamp.seconds ? b.timestamp.seconds * 1000 : new Date(b.timestamp).getTime()) : 0;
            return tB - tA;
        });

        entries.forEach(item => {
            const pts = parseFloat(item.points) || 0;
            const color = pts > 0 ? '#10b981' : (pts < 0 ? '#e02d2d' : 'var(--text-dark)');
            const sign = pts > 0 ? '+' : '';

            let dateStr = 'N/A';
            if (item.timestamp) {
                const d = item.timestamp.seconds ? new Date(item.timestamp.seconds * 1000) : new Date(item.timestamp);
                dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            const safeReason = (item.reason || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const safeStudentName = studentName.replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr>
                    <td style="font-size: 12px; color: var(--text-gray);">${dateStr}</td>
                    <td>${item.reason || 'N/A'}</td>
                    <td><strong style="color: ${color};">${sign}${pts}</strong></td>
                    <td>
                        <div style="display: flex; gap: 6px;">
                            <button class="edit-btn" onclick="editPointEntry('${item.docId}', '${safeReason}', ${pts}, '${studentCode}', '${safeStudentName}')">Edit</button>
                            <button class="delete-btn" onclick="deletePointEntry('${item.docId}', '${studentCode}', '${safeStudentName}')">Delete</button>
                        </div>
                    </td>
                </tr>
            `;
        });

    } catch (err) {
        console.error("Error fetching behavior history:", err);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: red;">Error loading logs.</td></tr>`;
    }
};

window.closeBehaviorHistoryModal = function () {
    const modal = document.getElementById('behaviorHistoryModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
};

window.editPointEntry = async function (docId, currentReason, currentPoints, studentCode, studentName) {
    const newReason = prompt("Modify Reason / Event:", currentReason);
    if (newReason === null) return;

    const newPtsStr = prompt("Modify Point Value (+ or -):", currentPoints);
    if (newPtsStr === null) return;

    const newPts = parseFloat(newPtsStr);
    if (isNaN(newPts) || !newReason.trim()) {
        alert("Please provide a valid point number and reason.");
        return;
    }

    try {
        await updateDoc(doc(db, "student_points", docId), {
            reason: newReason.trim(),
            points: newPts
        });

        alert("Behavior entry updated successfully!");

        // Refresh History Modal and Ledgers
        openBehaviorHistoryModal(studentCode, studentName);
        refreshBehaviorTabLedgers();
        if (typeof loadPointsTable === "function") loadPointsTable();
    } catch (e) {
        alert("Error updating behavior entry: " + e.message);
    }
};

window.deletePointEntry = async function (docId, studentCode, studentName) {
    if (confirm("Are you sure you want to permanently delete this behavior entry?")) {
        try {
            await deleteDoc(doc(db, "student_points", docId));
            alert("Entry deleted successfully!");

            // Refresh History Modal and Ledgers
            openBehaviorHistoryModal(studentCode, studentName);
            refreshBehaviorTabLedgers();
            if (typeof loadPointsTable === "function") loadPointsTable();
        } catch (e) {
            alert("Error deleting behavior entry: " + e.message);
        }
    }
};

// Bind button listener
document.getElementById('downloadTemplateBtn')?.addEventListener('click', downloadScoreTemplate);
// Bind change listeners to update quizzes dynamically
document.getElementById('bulkSubjectSelect')?.addEventListener('change', filterBulkQuizzes);
document.getElementById('bulkClassSelect')?.addEventListener('change', filterBulkQuizzes);

// Bind change listeners for ledger dropdowns
document.getElementById('ledgerSubjectSelect')?.addEventListener('change', filterLedgerQuizzes);
document.getElementById('ledgerClassSelect')?.addEventListener('change', filterLedgerQuizzes);

// Bind change listeners to update quiz options dynamically
document.getElementById('directSubjectSelect')?.addEventListener('change', filterDirectQuizzes);
document.getElementById('directClassSelect')?.addEventListener('change', filterDirectQuizzes);

// Expose functions globally for HTML button clicks
window.addManualQuiz = addManualQuiz;
window.deleteSystemRecord = deleteSystemRecord;
// Expose to window object for HTML onclick inline events
window.deleteQuiz = deleteQuiz;
window.viewQuizResults = viewQuizResults;
window.closeResultsModal = closeResultsModal;
window.editQuiz = editQuiz;


window.deleteQuiz = deleteQuiz;
document.getElementById('saveQuizBtn')?.addEventListener('click', saveQuiz);
document.getElementById('loadDirectStudentsBtn')?.addEventListener('click', loadClassRoster);
document.getElementById('saveDirectScoresBtn')?.addEventListener('click', saveDirectScores);
window.viewScoreLedger = viewScoreLedger;
window.exportChosenScoreToExcel = exportChosenScoreToExcel;

// Bind the new function to the window so the HTML buttons can trigger it
window.inlineAdjustPoint = inlineAdjustPoint;

// Bind the new bulk upload buttons
document.getElementById('sortStudents')?.addEventListener('change', loadStudentsDirectory);
document.getElementById('sortScores')?.addEventListener('change', loadAdminTable);
document.getElementById('sortPoints')?.addEventListener('change', loadPointsTable);
window.editTeacherSubjectSpecialty = editTeacherSubjectSpecialty;
window.editTeacherProfile = editTeacherProfile;
window.deleteNewsUpdate = deleteNewsUpdate;
window.addNewsUpdate = addNewsUpdate;
document.getElementById('postNewsBtn')?.addEventListener('click', addNewsUpdate);

// Bind Bulk Photo Drag & Drop Listeners
const bulkDropzone = document.getElementById('bulkPhotoDropzone');
const bulkFileInput = document.getElementById('bulkPhotoFileInput');

if (bulkDropzone) {
    ['dragenter', 'dragover'].forEach(eventName => {
        bulkDropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            bulkDropzone.style.borderColor = '#16a34a';
            bulkDropzone.style.background = 'rgba(22, 163, 74, 0.08)';
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        bulkDropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            bulkDropzone.style.borderColor = 'var(--primary-blue, #1e5eff)';
            bulkDropzone.style.background = 'rgba(30, 94, 255, 0.03)';
        });
    });

    bulkDropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt?.files;
        if (files && files.length > 0) {
            processBulkPhotoFiles(Array.from(files));
        }
    });
}

if (bulkFileInput) {
    bulkFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            processBulkPhotoFiles(Array.from(e.target.files));
        }
    });
}

// --- KEBAB & EDIT OFFLINE EXAM MODAL CONTROLLERS ---
window.toggleOfflineQuizKebab = function (e, id) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById(`offlineQuizKebab_${id}`);
    const isHidden = dropdown?.classList.contains('hidden');
    document.querySelectorAll('.profile-card-dropdown, .kebab-dropdown').forEach(d => d.classList.add('hidden'));
    if (isHidden && dropdown) {
        dropdown.classList.remove('hidden');
    }
};

window.openEditOfflineQuizModal = async function (id) {
    document.querySelectorAll('.profile-card-dropdown, .kebab-dropdown').forEach(d => d.classList.add('hidden'));
    try {
        const snap = await getDoc(doc(db, "system_quizzes", id));
        if (!snap.exists()) return alert("Exam record missing.");
        const data = snap.data();

        document.getElementById('editOfflineQuizId').value = id;
        document.getElementById('editOfflineQuizName').value = data.name || '';
        document.getElementById('editOfflineQuizType').value = data.type || (data.name.toLowerCase().includes('review') ? 'Review' : 'Quiz');

        // Populate subject options in edit modal
        const subjectSelect = document.getElementById('editOfflineQuizSubject');
        if (subjectSelect) {
            subjectSelect.innerHTML = '<option value="">-- Select Subject --</option>';
            const subjects = [
                "English", "Mathematics", "Science", "Indonesian", "Social Studies",
                "Civics / PPKN", "Religion", "Art & Culture", "Physical Education", "ICT / Computer"
            ];
            subjects.forEach(subj => {
                subjectSelect.innerHTML += `<option value="${subj}">${subj}</option>`;
            });
            subjectSelect.value = data.subject || '';
        }

        // Populate class checklist in edit modal
        const classContainer = document.getElementById('editOfflineQuizClassOptions');
        if (classContainer) {
            const classesSnap = await getDocs(collection(db, "students"));
            const classSet = new Set();
            classesSnap.forEach(sDoc => {
                const s = sDoc.data();
                if (s.studentClass) classSet.add(s.studentClass.trim());
            });
            const sortedClasses = Array.from(classSet).sort();

            let targetList = [];
            if (Array.isArray(data.targetClassesList)) {
                targetList = data.targetClassesList;
            } else if (data.targetClass) {
                targetList = data.targetClass.split(',').map(s => s.trim());
            }

            classContainer.innerHTML = `
                <label class="multi-select-option">
                    <input type="checkbox" value="All Classes" onchange="onEditOfflineQuizClassChange()" ${targetList.includes('All Classes') ? 'checked' : ''}>
                    <span>All Classes</span>
                </label>
            `;
            sortedClasses.forEach(cls => {
                classContainer.innerHTML += `
                    <label class="multi-select-option">
                        <input type="checkbox" value="${cls}" onchange="onEditOfflineQuizClassChange()" ${targetList.includes(cls) ? 'checked' : ''}>
                        <span>${cls}</span>
                    </label>
                `;
            });
            updateEditOfflineQuizClassLabel();
        }

        document.getElementById('editOfflineQuizModal')?.classList.remove('hidden');

    } catch (err) {
        console.error("Error opening edit modal:", err);
        alert("Error loading exam details: " + err.message);
    }
};

window.onEditOfflineQuizClassChange = function () {
    updateEditOfflineQuizClassLabel();
};

function getSelectedEditOfflineQuizClasses() {
    const checked = Array.from(document.querySelectorAll('#editOfflineQuizClassOptions input[type="checkbox"]:checked'));
    return checked.map(cb => cb.value);
}

function updateEditOfflineQuizClassLabel() {
    const selected = getSelectedEditOfflineQuizClasses();
    const label = document.getElementById('editOfflineQuizClassLabel');
    if (!label) return;
    if (selected.length === 0) {
        label.innerText = '-- Select Target Class --';
    } else if (selected.includes('All Classes')) {
        label.innerText = 'All Classes';
    } else if (selected.length <= 2) {
        label.innerText = selected.join(', ');
    } else {
        label.innerText = `${selected.length} Classes Selected`;
    }
}

window.closeEditOfflineQuizModal = function () {
    document.getElementById('editOfflineQuizModal')?.classList.add('hidden');
};

window.saveEditOfflineQuiz = async function () {
    const id = document.getElementById('editOfflineQuizId').value;
    const name = document.getElementById('editOfflineQuizName').value.trim();
    const type = document.getElementById('editOfflineQuizType').value;
    const subject = document.getElementById('editOfflineQuizSubject').value;
    const selectedClasses = getSelectedEditOfflineQuizClasses();
    const targetClassStr = selectedClasses.includes("All Classes") ? "All Classes" : selectedClasses.join(", ");

    if (!id || !name || !subject || selectedClasses.length === 0) {
        alert("Please enter an Exam Name, select a Subject, and check at least one Target Class.");
        return;
    }

    const saveBtn = document.getElementById('saveEditOfflineQuizBtn');
    try {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerText = "Saving...";
        }

        await updateDoc(doc(db, "system_quizzes", id), {
            name: name,
            type: type,
            subject: subject,
            targetClass: targetClassStr,
            targetClassesList: selectedClasses,
            updatedAt: new Date().toISOString()
        });

        // Also update any related system_quizzes docs with matching title
        const safeTitle = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const altDocIds = [`offline_${safeTitle}`, `gclass_${safeTitle}`, `offline_${name}`, `gclass_${name}`];
        altDocIds.forEach(altId => {
            if (altId !== id) {
                setDoc(doc(db, "system_quizzes", altId), {
                    name: name,
                    type: type,
                    subject: subject,
                    targetClass: targetClassStr,
                    targetClassesList: selectedClasses,
                    updatedAt: new Date().toISOString()
                }, { merge: true }).catch(() => {});
            }
        });

        // Propagate type & subject update to all student records in exam_scores
        try {
            const allScores = await getDocs(collection(db, "exam_scores"));
            const scoreUpdatePromises = [];
            allScores.forEach(sDoc => {
                const sData = sDoc.data();
                const sTitle = (sData.examName || sData.quizName || "").trim().toLowerCase();
                if (sTitle === name.toLowerCase()) {
                    scoreUpdatePromises.push(updateDoc(sDoc.ref, {
                        type: type,
                        subject: subject
                    }));
                }
            });
            await Promise.all(scoreUpdatePromises);
        } catch (scErr) {
            console.warn("Could not batch update exam_scores types:", scErr);
        }

        alert("Assignment updated successfully!");
        closeEditOfflineQuizModal();

        if (typeof window.loadSystemDatabases === "function") {
            await window.loadSystemDatabases();
        }

    } catch (err) {
        console.error("Error updating offline exam:", err);
        alert("Error saving offline exam: " + err.message);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = "Save Changes";
        }
    }
};

window.getSelectedEditOfflineQuizClasses = getSelectedEditOfflineQuizClasses;
window.updateEditOfflineQuizClassLabel = updateEditOfflineQuizClassLabel;

// ======================================================
// STUDENTS ATTENDANCE & PRESENT LIST SYSTEM (ADMIN/TEACHER)
// ======================================================

window.escapeHtml = escapeHtml;

let activeAttendanceSession = null;
let attendanceEnrolledStudents = [];
let attendanceRecordsMap = {}; // keyed by studentCode
let currentAttStatusFilter = 'all';
let attSearchQuery = '';
let attendanceRecordsUnsubscribe = null;

async function initAttendanceTab() {
    try {
        const dateInput = document.getElementById('attSessionDate');
        const subjectSelect = document.getElementById('attSessionSubject');
        const classSelect = document.getElementById('attSessionClass');

        // Set default date to today in YYYY-MM-DD
        if (dateInput && !dateInput.value) {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            dateInput.value = `${yyyy}-${mm}-${dd}`;
        }

        // Populate Subjects
        await populateAttendanceSubjects();

        // Populate Classes
        await populateAttendanceClasses();

        // Attach change events
        dateInput?.addEventListener('change', () => checkAndLoadAttendance());
        subjectSelect?.addEventListener('change', () => checkAndLoadAttendance());
        classSelect?.addEventListener('change', () => checkAndLoadAttendance());

        // Buttons
        document.getElementById('btnDeployAttendanceSession')?.addEventListener('click', deployAttendanceSession);
        document.getElementById('btnCloseAttendanceSession')?.addEventListener('click', closeAttendanceSession);
        document.getElementById('btnRefreshAttendance')?.addEventListener('click', () => checkAndLoadAttendance());
        document.getElementById('btnExportAttendanceExcel')?.addEventListener('click', exportAttendanceToExcel);
        document.getElementById('btnPrintAttendance')?.addEventListener('click', () => window.print());

        // Close dropdown when any action item is clicked
        document.getElementById('attActionDropdownMenu')?.addEventListener('click', (e) => {
            if (e.target.closest('.att-action-dropdown-item')) {
                closeAllAttDropdowns();
            }
        });

        // Search Input
        const searchInput = document.getElementById('attSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', debounce((e) => {
                attSearchQuery = e.target.value.trim().toLowerCase();
                renderAttendanceTable();
            }, 200));
        }

        // Initial check if values are ready
        if (subjectSelect?.value && classSelect?.value) {
            await checkAndLoadAttendance();
        }
    } catch (err) {
        console.error("Error initializing attendance tab:", err);
    }
}

async function populateAttendanceSubjects() {
    const subjectSelect = document.getElementById('attSessionSubject');
    if (!subjectSelect) return;

    const previousVal = subjectSelect.value;
    subjectSelect.innerHTML = '<option value="">-- Select Subject --</option>';

    const uniqueSubjects = new Set();
    if (userRole === 'admin') {
        try {
            const usersSnap = await getDocs(collection(db, "users"));
            usersSnap.forEach(docSnap => {
                const data = docSnap.data();
                const sub = data.subject || data.Subject || data.course;
                if (data.role === 'teacher' && sub && sub !== "Unassigned") {
                    sub.split(',').map(s => s.trim()).filter(Boolean).forEach(s => uniqueSubjects.add(s));
                }
            });
        } catch (e) {
            console.warn("Could not query teacher subjects from users collection:", e);
        }
    } else if (teacherSubject && teacherSubject !== "Unassigned") {
        teacherSubject.split(',').map(s => s.trim()).filter(Boolean).forEach(s => uniqueSubjects.add(s));
    }

    // Populate dropdown with database-synced teacher subjects
    Array.from(uniqueSubjects).sort().forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub;
        opt.textContent = sub;
        subjectSelect.appendChild(opt);
    });

    if (userRole === 'teacher' && teacherSubject && teacherSubject !== "Unassigned") {
        const teacherSubs = teacherSubject.split(',').map(s => s.trim()).filter(Boolean);
        if (teacherSubs.length > 0) {
            subjectSelect.value = teacherSubs[0];
            if (teacherSubs.length === 1) {
                subjectSelect.disabled = true;
            } else {
                subjectSelect.disabled = false;
            }
        }
    } else if (previousVal && uniqueSubjects.has(previousVal)) {
        subjectSelect.value = previousVal;
    } else if (subjectSelect.options.length > 1) {
        subjectSelect.selectedIndex = 1;
    }
}

async function populateAttendanceClasses() {
    const classSelect = document.getElementById('attSessionClass');
    if (!classSelect) return;

    const previousVal = classSelect.value;
    classSelect.innerHTML = '<option value="">-- Select Class --</option>';

    const uniqueClasses = new Set();
    try {
        const studentsSnap = await getDocs(collection(db, "students"));
        studentsSnap.forEach(docSnap => {
            const d = docSnap.data();
            const c = (d.studentClass || d.class || '').trim();
            if (c) uniqueClasses.add(c);
        });
    } catch (e) {
        console.warn("Could not query classes for attendance:", e);
    }

    if (uniqueClasses.size === 0) {
        ["7A", "7B", "8A", "8B", "9A", "9B", "10A", "10B", "11A", "11B", "12A", "12B"].forEach(c => uniqueClasses.add(c));
    }

    Array.from(uniqueClasses).sort().forEach(cls => {
        const opt = document.createElement('option');
        opt.value = cls;
        opt.textContent = `Class ${cls}`;
        classSelect.appendChild(opt);
    });

    if (previousVal && uniqueClasses.has(previousVal)) {
        classSelect.value = previousVal;
    } else if (classSelect.options.length > 1) {
        classSelect.selectedIndex = 1;
    }
}

async function checkAndLoadAttendance() {
    const date = document.getElementById('attSessionDate')?.value;
    const subject = document.getElementById('attSessionSubject')?.value;
    const selectedClass = document.getElementById('attSessionClass')?.value;

    const statusBadge = document.getElementById('attSessionStatusBadge');
    const statusText = document.getElementById('attStatusText');
    const activeInfo = document.getElementById('attActiveSessionInfo');
    const deployBtn = document.getElementById('btnDeployAttendanceSession');
    const closeBtn = document.getElementById('btnCloseAttendanceSession');
    const titleInput = document.getElementById('attSessionTitle');

    if (!date || !subject || !selectedClass) {
        if (statusBadge) {
            statusBadge.className = 'att-status-pill pill-inactive';
            if (statusText) statusText.innerText = 'Select Date, Subject & Class';
        }
        return;
    }

    // 1. Check for Session in Firestore
    try {
        const sessionQuery = query(
            collection(db, "attendance_sessions"),
            where("date", "==", date),
            where("subject", "==", subject)
        );
        const sessionSnap = await getDocs(sessionQuery);

        let foundSession = null;
        sessionSnap.forEach(docSnap => {
            const data = docSnap.data();
            if (data.targetClass === selectedClass || data.targetClass === "All Classes" || data.targetClass === "all") {
                foundSession = { id: docSnap.id, ...data };
            }
        });

        activeAttendanceSession = foundSession;

        if (foundSession && foundSession.status === 'active') {
            if (statusBadge) {
                statusBadge.className = 'att-status-pill pill-active';
                if (statusText) statusText.innerText = `Live Attendance Open (${foundSession.sessionTitle || 'Active'})`;
            }
            if (activeInfo) activeInfo.innerText = `Live session deployed on ${foundSession.date} for ${foundSession.subject} - Class ${foundSession.targetClass}. Real-time student responses streaming below.`;
            if (closeBtn) closeBtn.classList.remove('hidden');
            document.getElementById('attCloseSessionDivider')?.classList.remove('hidden');
            if (deployBtn) deployBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> <span>Update Session Title</span>`;
            if (titleInput && foundSession.sessionTitle) titleInput.value = foundSession.sessionTitle;
        } else if (foundSession && foundSession.status === 'closed') {
            if (statusBadge) {
                statusBadge.className = 'att-status-pill pill-inactive';
                if (statusText) statusText.innerText = `Session Closed (${foundSession.sessionTitle || 'Ended'})`;
            }
            if (activeInfo) activeInfo.innerText = `This attendance session was closed on ${foundSession.date}. You can re-open/deploy it anytime.`;
            if (closeBtn) closeBtn.classList.add('hidden');
            document.getElementById('attCloseSessionDivider')?.classList.add('hidden');
            if (deployBtn) deployBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> <span>Re-Open Attendance Call</span>`;
            if (titleInput && foundSession.sessionTitle) titleInput.value = foundSession.sessionTitle;
        } else {
            if (statusBadge) {
                statusBadge.className = 'att-status-pill pill-inactive';
                if (statusText) statusText.innerText = 'No Active Session Deployed';
            }
            if (activeInfo) activeInfo.innerText = '';
            if (closeBtn) closeBtn.classList.add('hidden');
            document.getElementById('attCloseSessionDivider')?.classList.add('hidden');
            if (deployBtn) deployBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> <span>Deploy Attendance Call</span>`;
        }

        // 2. Fetch Enrolled Students for this Class
        const studentsQuery = query(collection(db, "students"), where("studentClass", "==", selectedClass));
        const studentsSnap = await getDocs(studentsQuery);
        attendanceEnrolledStudents = [];
        studentsSnap.forEach(docSnap => {
            attendanceEnrolledStudents.push({
                code: docSnap.id,
                ...docSnap.data()
            });
        });

        // Sort students alphabetically by name
        attendanceEnrolledStudents.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));

        // 3. Listen to Attendance Records in Real Time
        if (attendanceRecordsUnsubscribe) {
            attendanceRecordsUnsubscribe();
            attendanceRecordsUnsubscribe = null;
        }

        const recordsQuery = query(
            collection(db, "attendance_records"),
            where("date", "==", date),
            where("subject", "==", subject)
        );

        attendanceRecordsUnsubscribe = onSnapshot(recordsQuery, (snapshot) => {
            attendanceRecordsMap = {};
            snapshot.forEach(docSnap => {
                const rec = docSnap.data();
                if (rec.studentCode) {
                    attendanceRecordsMap[rec.studentCode] = { id: docSnap.id, ...rec };
                }
            });
            renderAttendanceTable();
        }, (err) => {
            console.error("Attendance real-time snapshot error:", err);
        });

    } catch (err) {
        console.error("Error checking and loading attendance:", err);
    }
}

function renderAttendanceTable() {
    const tbody = document.getElementById('attendanceRecordsTbody');
    if (!tbody) return;

    let presentCount = 0;
    let absentCount = 0;
    let othersCount = 0;
    let pendingCount = 0;

    const totalStudents = attendanceEnrolledStudents.length;

    // Process all enrolled students and compute metrics
    const studentRows = attendanceEnrolledStudents.map(student => {
        const rec = attendanceRecordsMap[student.code];
        const status = rec ? rec.status : 'pending';
        const reason = rec ? (rec.reason || '') : '';
        const timestamp = rec ? (rec.timestamp || '') : '';
        const markedBy = rec ? (rec.markedBy || 'student') : '';

        if (status === 'present') presentCount++;
        else if (status === 'absent') absentCount++;
        else if (status === 'others') othersCount++;
        else pendingCount++;

        return {
            student,
            record: rec,
            status,
            reason,
            timestamp,
            markedBy
        };
    });

    // Update Counter Badges & Percentages
    const calcPct = (count) => totalStudents > 0 ? Math.round((count / totalStudents) * 100) + '%' : '0%';

    const countTotalEl = document.getElementById('attCountTotal');
    const countPresentEl = document.getElementById('attCountPresent');
    const countAbsentEl = document.getElementById('attCountAbsent');
    const countOthersEl = document.getElementById('attCountOthers');
    const countPendingEl = document.getElementById('attCountPending');

    if (countTotalEl) countTotalEl.innerText = totalStudents;
    if (countPresentEl) countPresentEl.innerText = presentCount;
    if (countAbsentEl) countAbsentEl.innerText = absentCount;
    if (countOthersEl) countOthersEl.innerText = othersCount;
    if (countPendingEl) countPendingEl.innerText = pendingCount;

    const pctPresentEl = document.getElementById('attPctPresent');
    const pctAbsentEl = document.getElementById('attPctAbsent');
    const pctOthersEl = document.getElementById('attPctOthers');
    const pctPendingEl = document.getElementById('attPctPending');

    if (pctPresentEl) pctPresentEl.innerText = calcPct(presentCount);
    if (pctAbsentEl) pctAbsentEl.innerText = calcPct(absentCount);
    if (pctOthersEl) pctOthersEl.innerText = calcPct(othersCount);
    if (pctPendingEl) pctPendingEl.innerText = calcPct(pendingCount);

    // Update Filter Select Options with live counts
    const statusSelect = document.getElementById('attStatusFilterSelect');
    if (statusSelect) {
        const optAll = statusSelect.querySelector('option[value="all"]');
        const optPresent = statusSelect.querySelector('option[value="present"]');
        const optAbsent = statusSelect.querySelector('option[value="absent"]');
        const optOthers = statusSelect.querySelector('option[value="others"]');
        const optPending = statusSelect.querySelector('option[value="pending"]');

        if (optAll) optAll.innerText = `All (${totalStudents})`;
        if (optPresent) optPresent.innerText = `Present (${presentCount})`;
        if (optAbsent) optAbsent.innerText = `Absent (${absentCount})`;
        if (optOthers) optOthers.innerText = `Others (${othersCount})`;
        if (optPending) optPending.innerText = `Pending (${pendingCount})`;
    }

    // Filter list
    let filtered = studentRows;
    if (currentAttStatusFilter !== 'all') {
        filtered = filtered.filter(item => item.status === currentAttStatusFilter);
    }
    if (attSearchQuery) {
        filtered = filtered.filter(item => {
            const name = (item.student.studentName || '').toLowerCase();
            const code = (item.student.code || '').toLowerCase();
            return name.includes(attSearchQuery) || code.includes(attSearchQuery);
        });
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-gray); padding: 32px 16px;">
                    ${totalStudents === 0 ? 'No students enrolled in this class.' : 'No students match the current status filter or search query.'}
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = "";
    filtered.forEach((item, index) => {
        const s = item.student;
        const status = item.status;
        const reason = item.reason;
        const timeStr = item.timestamp ? formatTimeDisplay(item.timestamp) : '-';

        let badgeHtml = '';
        if (status === 'present') {
            badgeHtml = `<span class="att-badge att-badge-present"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> Present (Hadir)</span>`;
        } else if (status === 'absent') {
            badgeHtml = `<span class="att-badge att-badge-absent"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Absent (Tidak Hadir)</span>`;
        } else if (status === 'others') {
            badgeHtml = `<span class="att-badge att-badge-others" title="${escapeHtml(reason)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> Others${reason ? ` (${escapeHtml(reason)})` : ''}</span>`;
        } else {
            badgeHtml = `<span class="att-badge att-badge-pending"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Not Marked</span>`;
        }

        const reasonDisplay = reason ? `<span style="font-size: 13px; font-weight: 500; color: var(--text-dark);">${escapeHtml(reason)}</span>` : `<span style="color: var(--text-gray); font-size: 12px; font-style: italic;">None</span>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="text-align: center; font-weight: 600; color: var(--text-gray); font-size: 13px;">${index + 1}</td>
            <td>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: #e0e7ff; color: #4338ca; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0;">
                        ${(s.studentName || 'S').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <strong style="color: var(--text-dark); font-size: 13.5px; display: block;">${escapeHtml(s.studentName || 'Student')}</strong>
                        <span style="font-size: 11.5px; color: var(--text-gray);">${s.gender ? escapeHtml(s.gender) : ''}</span>
                    </div>
                </div>
            </td>
            <td style="font-weight: 600; font-size: 13px; color: var(--text-dark);">${escapeHtml(s.studentClass || '')}</td>
            <td>${badgeHtml}</td>
            <td>${reasonDisplay}</td>
            <td style="font-size: 12px; color: var(--text-gray); white-space: nowrap;">${timeStr}</td>
            <td style="text-align: center; position: relative;">
                <div class="att-kebab-menu">
                    <button type="button" class="att-kebab-trigger" title="Actions" aria-label="Actions" onclick="toggleAttendanceRowMenu(event, '${escapeHtml(s.code)}')">⋮</button>
                    <div id="att-menu-${escapeHtml(s.code)}" class="att-row-dropdown hidden">
                        <button type="button" class="att-row-item opt-present" onclick="quickMarkAttendance('${escapeHtml(s.code)}', '${escapeHtml(s.studentName || '')}', '${escapeHtml(s.studentClass || '')}', 'present'); closeAllAttDropdowns();">
                            <span class="att-item-icon-wrap" style="color: #10b981; background: rgba(16,185,129,0.12);">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            </span>
                            <span>Present</span>
                        </button>
                        <button type="button" class="att-row-item opt-absent" onclick="quickMarkAttendance('${escapeHtml(s.code)}', '${escapeHtml(s.studentName || '')}', '${escapeHtml(s.studentClass || '')}', 'absent'); closeAllAttDropdowns();">
                            <span class="att-item-icon-wrap" style="color: #ef4444; background: rgba(239,68,68,0.12);">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </span>
                            <span>Absent</span>
                        </button>
                        <button type="button" class="att-row-item opt-note" onclick="openAttManualModal('${escapeHtml(s.code)}', '${escapeHtml(s.studentName || '')}', '${escapeHtml(s.studentClass || '')}', '${status}', '${escapeHtml(reason)}'); closeAllAttDropdowns();">
                            <span class="att-item-icon-wrap" style="color: #6366f1; background: rgba(99,102,241,0.12);">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                            </span>
                            <span>Note</span>
                        </button>
                    </div>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function formatTimeDisplay(raw) {
    if (!raw) return '-';
    try {
        const d = new Date(raw);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return '-';
    }
}

window.filterAttendanceStatus = function(status) {
    currentAttStatusFilter = status;
    const select = document.getElementById('attStatusFilterSelect');
    if (select && select.value !== status) {
        select.value = status;
    }
    renderAttendanceTable();
};

async function deployAttendanceSession() {
    const date = document.getElementById('attSessionDate')?.value;
    const subject = document.getElementById('attSessionSubject')?.value;
    const selectedClass = document.getElementById('attSessionClass')?.value;
    const title = document.getElementById('attSessionTitle')?.value.trim() || 'Regular Class';

    if (!date || !subject || !selectedClass) {
        alert("Please select Session Date, Subject, and Target Class.");
        return;
    }

    const deployBtn = document.getElementById('btnDeployAttendanceSession');
    try {
        if (deployBtn) {
            deployBtn.disabled = true;
            deployBtn.innerText = "Deploying...";
        }

        const sessionId = `${date}_${subject.replace(/\s+/g, '_')}_${selectedClass.replace(/\s+/g, '_')}`;
        
        await setDoc(doc(db, "attendance_sessions", sessionId), {
            date: date,
            subject: subject,
            targetClass: selectedClass,
            sessionTitle: title,
            status: 'active',
            teacherName: document.getElementById('sidebarUserName')?.innerText || 'Teacher',
            teacherEmail: auth.currentUser ? auth.currentUser.email : 'teacher@mks.sch.id',
            updatedAt: new Date().toISOString()
        }, { merge: true });

        alert(`Attendance Session Deployed Successfully!\nSubject: ${subject}\nClass: ${selectedClass}\nDate: ${date}\n\nStudents visiting the portal will now see the attendance call.`);
        await checkAndLoadAttendance();

    } catch (err) {
        console.error("Error deploying attendance session:", err);
        alert("Failed to deploy attendance session: " + err.message);
    } finally {
        if (deployBtn) {
            deployBtn.disabled = false;
            deployBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> <span>Deploy Attendance Call</span>`;
        }
    }
}

async function closeAttendanceSession() {
    if (!activeAttendanceSession) {
        alert("No active session found.");
        return;
    }

    if (confirm(`Are you sure you want to CLOSE the attendance session for ${activeAttendanceSession.subject} - Class ${activeAttendanceSession.targetClass}? Students will no longer see the attendance prompt.`)) {
        try {
            await updateDoc(doc(db, "attendance_sessions", activeAttendanceSession.id), {
                status: 'closed',
                closedAt: new Date().toISOString()
            });

            alert("Attendance session has been closed.");
            await checkAndLoadAttendance();

        } catch (err) {
            console.error("Error closing attendance session:", err);
            alert("Failed to close session: " + err.message);
        }
    }
}

window.quickMarkAttendance = async function(studentCode, studentName, studentClass, newStatus) {
    const date = document.getElementById('attSessionDate')?.value;
    const subject = document.getElementById('attSessionSubject')?.value;

    if (!date || !subject) {
        alert("Please ensure Session Date and Subject are selected.");
        return;
    }

    try {
        const recordId = `${date}_${subject.replace(/\s+/g, '_')}_${studentCode}`;
        await setDoc(doc(db, "attendance_records", recordId), {
            sessionId: activeAttendanceSession ? activeAttendanceSession.id : `${date}_${subject}_${studentClass}`,
            date: date,
            subject: subject,
            studentCode: studentCode,
            studentName: studentName,
            studentClass: studentClass,
            status: newStatus,
            reason: '',
            timestamp: new Date().toISOString(),
            markedBy: 'teacher'
        }, { merge: true });

    } catch (err) {
        console.error("Error updating attendance:", err);
        alert("Failed to update attendance: " + err.message);
    }
};

window.openAttManualModal = function(studentCode, studentName, studentClass, currentStatus, currentReason) {
    const modal = document.getElementById('attManualModal');
    if (!modal) return;

    document.getElementById('attManualStudentCode').value = studentCode;
    document.getElementById('attManualStudentName').value = studentName;
    document.getElementById('attManualStudentClass').value = studentClass;
    document.getElementById('attManualStudentInfo').innerText = `${studentName} (Class ${studentClass} • Code: ${studentCode})`;

    const statusSelect = document.getElementById('attManualStatusSelect');
    if (statusSelect) {
        statusSelect.value = (currentStatus === 'present' || currentStatus === 'absent' || currentStatus === 'others') ? currentStatus : 'present';
    }

    const reasonInput = document.getElementById('attManualReasonInput');
    if (reasonInput) {
        reasonInput.value = currentReason || '';
    }

    onAttManualStatusChange();
    modal.classList.remove('hidden');
};

window.closeAttManualModal = function() {
    document.getElementById('attManualModal')?.classList.add('hidden');
};

window.toggleAttendanceRowMenu = function(event, code) {
    if (event) event.stopPropagation();
    const menuId = `att-menu-${code}`;
    const targetMenu = document.getElementById(menuId);
    
    // Close other row menus
    document.querySelectorAll('.att-row-dropdown').forEach(m => {
        if (m.id !== menuId) m.classList.add('hidden');
    });
    // Close split dropdown
    const actionDropdown = document.getElementById('attActionDropdownMenu');
    if (actionDropdown) actionDropdown.classList.add('hidden');
    const toggleBtn = document.getElementById('btnAttendanceMenuToggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');

    if (targetMenu) {
        targetMenu.classList.toggle('hidden');
    }
};

window.toggleAttendanceActionsDropdown = function(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('attActionDropdownMenu');
    const toggleBtn = document.getElementById('btnAttendanceMenuToggle');
    if (!dropdown) return;
    
    // Close any open row menus
    document.querySelectorAll('.att-row-dropdown').forEach(m => m.classList.add('hidden'));

    const isHidden = dropdown.classList.toggle('hidden');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(!isHidden));
};

window.closeAllAttDropdowns = function() {
    document.querySelectorAll('.att-row-dropdown').forEach(m => m.classList.add('hidden'));
    const dropdown = document.getElementById('attActionDropdownMenu');
    if (dropdown) dropdown.classList.add('hidden');
    const toggleBtn = document.getElementById('btnAttendanceMenuToggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
};

// Global click listener to close attendance and score dropdowns when clicking outside
window.addEventListener('click', (e) => {
    if (!e.target.closest('.att-kebab-menu') && !e.target.closest('.att-split-btn-wrapper')) {
        closeAllAttDropdowns();
    }
    if (!e.target.closest('.score-mode-dropdown-wrap')) {
        closeScoreModeDropdown();
    }
    if (!e.target.closest('.score-ledger-split-wrap') && !e.target.closest('.score-ledger-split-btn-wrap')) {
        closeScoreLedgerDropdown();
    }
});

window.onAttManualStatusChange = function() {
    const status = document.getElementById('attManualStatusSelect')?.value;
    const reasonBox = document.getElementById('attManualReasonBox');
    if (reasonBox) {
        // Show reason input for others or as optional note
        reasonBox.style.display = (status === 'others' || status === 'absent' || status === 'present') ? 'block' : 'none';
        const label = reasonBox.querySelector('label');
        if (label) {
            label.innerText = status === 'others' ? 'Reason / Explanation (Required for Others)' : 'Optional Teacher Note';
        }
    }
};

window.saveManualAttendanceRecord = async function() {
    const studentCode = document.getElementById('attManualStudentCode')?.value;
    const studentName = document.getElementById('attManualStudentName')?.value;
    const studentClass = document.getElementById('attManualStudentClass')?.value;
    const status = document.getElementById('attManualStatusSelect')?.value;
    const reason = document.getElementById('attManualReasonInput')?.value.trim();

    const date = document.getElementById('attSessionDate')?.value;
    const subject = document.getElementById('attSessionSubject')?.value;

    if (!studentCode || !date || !subject) {
        alert("Missing student code, date, or subject.");
        return;
    }

    if (status === 'others' && !reason) {
        alert("Please provide a reason for 'Others' (e.g. Sakit Demam, Izin Dokter, dll).");
        return;
    }

    const recordId = `${date}_${subject.replace(/\s+/g, '_')}_${studentCode}`;

    try {
        if (status === 'pending') {
            // Delete record to reset to unmarked
            await deleteDoc(doc(db, "attendance_records", recordId));
        } else {
            await setDoc(doc(db, "attendance_records", recordId), {
                sessionId: activeAttendanceSession ? activeAttendanceSession.id : `${date}_${subject}_${studentClass}`,
                date: date,
                subject: subject,
                studentCode: studentCode,
                studentName: studentName,
                studentClass: studentClass,
                status: status,
                reason: reason,
                timestamp: new Date().toISOString(),
                markedBy: 'teacher'
            }, { merge: true });
        }

        closeAttManualModal();
    } catch (err) {
        console.error("Error saving manual attendance:", err);
        alert("Failed to save attendance: " + err.message);
    }
};

function exportAttendanceToExcel() {
    if (typeof XLSX === 'undefined') {
        alert("Excel export library is loading, please try again in a moment.");
        return;
    }

    const date = document.getElementById('attSessionDate')?.value || 'Today';
    const subject = document.getElementById('attSessionSubject')?.value || 'Subject';
    const selectedClass = document.getElementById('attSessionClass')?.value || 'Class';

    if (attendanceEnrolledStudents.length === 0) {
        alert("No student attendance data to export.");
        return;
    }

    const rows = [
        ["MITRA KASIH SCHOOL - ATTENDANCE REPORT"],
        [`Date: ${date}`, `Subject: ${subject}`, `Class: ${selectedClass}`],
        [""],
        ["No", "Student Name", "Student Code", "Class", "Attendance Status", "Reason / Note", "Time Logged", "Marked By"]
    ];

    attendanceEnrolledStudents.forEach((student, i) => {
        const rec = attendanceRecordsMap[student.code];
        const status = rec ? rec.status.toUpperCase() : 'PENDING (NOT MARKED)';
        const reason = rec ? (rec.reason || '') : '';
        const time = rec && rec.timestamp ? new Date(rec.timestamp).toLocaleTimeString() : '-';
        const markedBy = rec ? (rec.markedBy || 'Student') : '-';

        rows.push([
            i + 1,
            student.studentName || '',
            student.code,
            student.studentClass || '',
            status,
            reason,
            time,
            markedBy
        ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance");

    const fileName = `Attendance_${subject}_${selectedClass}_${date}.xlsx`;
    XLSX.writeFile(wb, fileName);
}

// ==========================================================================
// TEACHER / ADMIN PROFILE MANAGEMENT & MODAL (PHOTO, EMAIL, PASSWORD, NAME)
// ==========================================================================

const EYE_OPEN_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

function showTeacherModalAlert(msg, type = 'info') {
    const alertEl = document.getElementById('teacherProfileAlert');
    if (!alertEl) return;
    alertEl.classList.remove('hidden');
    alertEl.style.display = 'flex';
    alertEl.style.alignItems = 'center';
    alertEl.style.gap = '8px';

    if (type === 'error') {
        alertEl.style.background = '#fef2f2';
        alertEl.style.border = '1px solid #fecaca';
        alertEl.style.color = '#b91c1c';
        alertEl.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <div><strong>Error:</strong> ${escapeHtml(msg)}</div>
        `;
    } else if (type === 'success') {
        alertEl.style.background = '#f0fdf4';
        alertEl.style.border = '1px solid #bbf7d0';
        alertEl.style.color = '#15803d';
        alertEl.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <div><strong>Success:</strong> ${escapeHtml(msg)}</div>
        `;
    } else {
        alertEl.style.background = '#eff6ff';
        alertEl.style.border = '1px solid #bfdbfe';
        alertEl.style.color = '#1d4ed8';
        alertEl.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <div>${escapeHtml(msg)}</div>
        `;
    }
}

function hideTeacherModalAlert() {
    const alertEl = document.getElementById('teacherProfileAlert');
    if (alertEl) {
        alertEl.classList.add('hidden');
        alertEl.style.display = 'none';
        alertEl.innerHTML = '';
    }
}

window.togglePasswordVisibility = function(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = EYE_OFF_SVG;
        btn.title = 'Hide password';
    } else {
        input.type = 'password';
        btn.innerHTML = EYE_OPEN_SVG;
        btn.title = 'Show password';
    }
};

window.openTeacherProfileModal = async function() {
    const currentUser = auth.currentUser;
    if (!currentUser) {
        alert("Please log in to edit your profile.");
        return;
    }

    // Close mobile dropdown if open
    document.getElementById('mobileTopbarDropdown')?.classList.add('hidden');

    hideTeacherModalAlert();
    pendingTeacherPhotoFile = null;
    teacherPhotoRemoved = false;

    const photoInput = document.getElementById('teacherPhotoFileInput');
    if (photoInput) photoInput.value = '';

    // Fetch fresh user record from Firestore
    let freshUserData = currentTeacherProfileData || {};
    try {
        const uSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (uSnap.exists()) {
            freshUserData = uSnap.data();
            currentTeacherProfileData = { ...freshUserData, uid: currentUser.uid };
        }
    } catch (e) {
        console.warn("Could not fetch fresh user data for profile modal:", e);
    }

    const currentEmail = currentUser.email || freshUserData.email || "";
    const rawFallbackName = currentEmail.split('@')[0]
        .replace(/[._]/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
    const currentName = freshUserData.name || currentUser.displayName || rawFallbackName || "Teacher";
    const currentPhotoUrl = freshUserData.photoUrl || currentUser.photoURL || null;
    const currentRole = freshUserData.role || userRole || "teacher";
    const currentSub = freshUserData.subject || teacherSubject || "Unassigned";

    // Populate input fields
    const nameInput = document.getElementById('teacherEditName');
    const emailInput = document.getElementById('teacherEditEmail');
    const passInput = document.getElementById('teacherEditPassword');
    const passConfirmInput = document.getElementById('teacherEditPasswordConfirm');
    const hintEl = document.getElementById('teacherPhotoDriveFilenameHint');

    if (nameInput) nameInput.value = currentName;
    if (emailInput) emailInput.value = currentEmail;
    if (passInput) {
        passInput.value = '';
        passInput.type = 'password';
    }
    if (passConfirmInput) {
        passConfirmInput.value = '';
        passConfirmInput.type = 'password';
    }
    document.querySelectorAll('#teacherProfileModal .password-eye-btn').forEach(btn => {
        btn.innerHTML = EYE_OPEN_SVG;
        btn.title = 'Show password';
    });
    if (hintEl) hintEl.innerText = `${currentEmail ? currentEmail.trim().toLowerCase() : 'teacher@mks.sch.id'}.jpg`;

    // Role & Subject badges
    const roleBadge = document.getElementById('teacherModalRoleBadge');
    const subBadge = document.getElementById('teacherModalSubjectBadge');
    if (roleBadge) roleBadge.innerText = currentRole === 'admin' ? 'Super Admin' : 'Teacher';
    if (subBadge) subBadge.innerText = currentSub || 'General';

    // Modal Avatar Preview
    const avatarPreview = document.getElementById('teacherModalAvatarPreview');
    const removeBtn = document.getElementById('teacherPhotoRemoveBtn');
    const initial = currentName.charAt(0).toUpperCase();

    if (avatarPreview) {
        if (currentPhotoUrl) {
            avatarPreview.innerHTML = `<img src="${currentPhotoUrl}" alt="${escapeHtml(currentName)}" onerror="this.onerror=null; this.parentElement.innerText='${initial}';">`;
            if (removeBtn) removeBtn.style.display = 'inline';
        } else {
            avatarPreview.innerHTML = '';
            avatarPreview.innerText = initial;
            if (removeBtn) removeBtn.style.display = 'none';
        }
    }

    // Display modal
    const modal = document.getElementById('teacherProfileModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
};

window.closeTeacherProfileModal = function() {
    const modal = document.getElementById('teacherProfileModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    pendingTeacherPhotoFile = null;
    teacherPhotoRemoved = false;
    hideTeacherModalAlert();
};

window.removeTeacherPhotoPreview = function() {
    pendingTeacherPhotoFile = null;
    teacherPhotoRemoved = true;

    const photoInput = document.getElementById('teacherPhotoFileInput');
    if (photoInput) photoInput.value = '';

    const nameInput = document.getElementById('teacherEditName');
    const initial = (nameInput?.value.trim() || 'U').charAt(0).toUpperCase();

    const avatarPreview = document.getElementById('teacherModalAvatarPreview');
    if (avatarPreview) {
        avatarPreview.innerHTML = '';
        avatarPreview.innerText = initial;
    }

    const removeBtn = document.getElementById('teacherPhotoRemoveBtn');
    if (removeBtn) removeBtn.style.display = 'none';
};

// Handle file input change and dynamic filename hint
function initTeacherProfileModalEvents() {
    const photoInput = document.getElementById('teacherPhotoFileInput');
    if (photoInput) {
        photoInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showTeacherModalAlert("Please choose an image file (JPG, PNG, or WebP).", "error");
                photoInput.value = '';
                return;
            }

            if (file.size > 15 * 1024 * 1024) {
                showTeacherModalAlert("Photo is too large (maximum 15MB).", "error");
                photoInput.value = '';
                return;
            }

            pendingTeacherPhotoFile = file;
            teacherPhotoRemoved = false;
            hideTeacherModalAlert();

            try {
                const previewDataUrl = await resizeImageToDataUrl(file, 400, 400, 0.85);
                const avatarPreview = document.getElementById('teacherModalAvatarPreview');
                if (avatarPreview) {
                    avatarPreview.innerHTML = `<img src="${previewDataUrl}" alt="Preview">`;
                }
                const removeBtn = document.getElementById('teacherPhotoRemoveBtn');
                if (removeBtn) removeBtn.style.display = 'inline';
            } catch (err) {
                console.error("Error previewing teacher photo:", err);
            }
        });
    }

    // Dynamic filename hint update on email change
    const emailInput = document.getElementById('teacherEditEmail');
    if (emailInput) {
        emailInput.addEventListener('input', () => {
            const hintEl = document.getElementById('teacherPhotoDriveFilenameHint');
            const clean = emailInput.value.trim().toLowerCase();
            if (hintEl) hintEl.innerText = `${clean || 'teacher@mks.sch.id'}.jpg`;
        });
    }

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('teacherProfileModal');
            if (modal && !modal.classList.contains('hidden') && modal.style.display !== 'none') {
                window.closeTeacherProfileModal();
            }
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTeacherProfileModalEvents);
} else {
    initTeacherProfileModalEvents();
}

window.saveTeacherProfile = async function() {
    const currentUser = auth.currentUser;
    if (!currentUser) {
        showTeacherModalAlert("You must be logged in to save profile changes.", "error");
        return;
    }

    const saveBtn = document.getElementById('btnSaveTeacherProfile');
    const nameInput = document.getElementById('teacherEditName');
    const emailInput = document.getElementById('teacherEditEmail');
    const passInput = document.getElementById('teacherEditPassword');
    const passConfirmInput = document.getElementById('teacherEditPasswordConfirm');

    const newName = nameInput ? nameInput.value.trim() : '';
    const newEmail = emailInput ? emailInput.value.trim().toLowerCase() : '';
    const newPassword = passInput ? passInput.value : '';
    const confirmPassword = passConfirmInput ? passConfirmInput.value : '';

    if (!newName) {
        showTeacherModalAlert("Please enter your name.", "error");
        nameInput?.focus();
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!newEmail || !emailRegex.test(newEmail)) {
        showTeacherModalAlert("Please enter a valid email address.", "error");
        emailInput?.focus();
        return;
    }

    if (newPassword) {
        if (newPassword.length < 6) {
            showTeacherModalAlert("New password must be at least 6 characters long.", "error");
            passInput?.focus();
            return;
        }
        if (newPassword !== confirmPassword) {
            showTeacherModalAlert("Passwords do not match. Please re-enter.", "error");
            passConfirmInput?.focus();
            return;
        }
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `
            <svg style="animation: spin 1s linear infinite; width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10"></path>
            </svg>
            <span>Saving Changes...</span>
        `;
    }
    hideTeacherModalAlert();

    try {
        let finalPhotoUrl = currentTeacherProfileData?.photoUrl || currentUser.photoURL || null;

        // 1. Process & Upload Photo to Google Drive in same folder as students (picdb), identified by teacher email
        if (pendingTeacherPhotoFile) {
            if (saveBtn) saveBtn.innerHTML = `<span>Uploading photo to picdb...</span>`;

            // Resize & optimize photo
            const optimizedDataUrl = await resizeImageToDataUrl(pendingTeacherPhotoFile, 500, 500, 0.85);

            // Fetch Google Drive settings from localStorage or Firestore system_settings/google_drive
            let driveScriptUrl = localStorage.getItem('profileDriveScriptUrl') || localStorage.getItem('googleDriveScriptUrl') || '';
            let profileFolderId = localStorage.getItem('profileDriveFolderId') || '';

            if (!driveScriptUrl) {
                try {
                    let snap = await getDoc(doc(db, "system_settings", "google_drive"));
                    if (!snap.exists()) snap = await getDoc(doc(db, "system_settings", "googleDrive"));
                    if (snap.exists()) {
                        const sData = snap.data();
                        driveScriptUrl = sData.profileScriptUrl || sData.scriptUrlProfile || sData.scriptUrl || '';
                        profileFolderId = sData.profileFolderId || sData.folderIdProfile || profileFolderId;
                        if (driveScriptUrl) {
                            localStorage.setItem('profileDriveScriptUrl', driveScriptUrl);
                            localStorage.setItem('googleDriveScriptUrl', driveScriptUrl);
                        }
                        if (profileFolderId) {
                            localStorage.setItem('profileDriveFolderId', profileFolderId);
                        }
                    }
                } catch (dErr) {
                    console.warn("Could not fetch Google Drive settings from Firestore:", dErr);
                }
            }

            // Filename identifying teacher by email in the exact same folder as student photos (picdb)
            const targetFileName = `${newEmail}.jpg`;

            if (driveScriptUrl) {
                try {
                    const base64Data = optimizedDataUrl.split(',')[1];
                    const response = await fetch(driveScriptUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            fileName: targetFileName,
                            studentCode: newEmail,
                            mimeType: 'image/jpeg',
                            base64Data: base64Data,
                            folderName: "picdb",
                            folderId: profileFolderId || '',
                            replaceExisting: true
                        })
                    });

                    const resText = await response.text();
                    let resJson = null;
                    try {
                        resJson = JSON.parse(resText);
                    } catch (_) {}

                    if (resJson && resJson.status === 'success') {
                        finalPhotoUrl = resJson.photoUrl || resJson.url || resJson.directUrl || (resJson.fileId ? `https://lh3.googleusercontent.com/d/${resJson.fileId}` : optimizedDataUrl);
                    } else {
                        console.warn("Apps Script upload did not return success, using optimized data URL:", resJson);
                        finalPhotoUrl = optimizedDataUrl;
                    }
                } catch (upErr) {
                    console.warn("Error uploading photo to Drive Apps Script, fallback to data URL:", upErr);
                    finalPhotoUrl = optimizedDataUrl;
                }
            } else {
                console.info("No Google Drive script configured, storing optimized photo directly.");
                finalPhotoUrl = optimizedDataUrl;
            }
        } else if (teacherPhotoRemoved) {
            finalPhotoUrl = null;
        }

        // 2. Update Firebase Auth Password (if provided)
        if (newPassword) {
            if (saveBtn) saveBtn.innerHTML = `<span>Updating password...</span>`;
            await updatePassword(currentUser, newPassword);
        }

        // 3. Update Firebase Auth Email (if changed)
        const currentAuthEmail = (currentUser.email || '').toLowerCase();
        if (newEmail !== currentAuthEmail) {
            if (saveBtn) saveBtn.innerHTML = `<span>Updating email...</span>`;
            await updateEmail(currentUser, newEmail);
        }

        // 4. Update Firebase Auth Profile (displayName & photoURL)
        if (saveBtn) saveBtn.innerHTML = `<span>Updating account profile...</span>`;
        await updateProfile(currentUser, {
            displayName: newName,
            photoURL: finalPhotoUrl || ''
        });

        // 5. Update Firestore users/{uid} document
        const userDocRef = doc(db, "users", currentUser.uid);
        const updatePayload = {
            name: newName,
            email: newEmail,
            photoUrl: finalPhotoUrl,
            updatedAt: new Date().toISOString()
        };
        await setDoc(userDocRef, updatePayload, { merge: true });

        // 6. Update local in-memory profile state
        currentTeacherProfileData = {
            ...currentTeacherProfileData,
            ...updatePayload,
            uid: currentUser.uid
        };

        // 7. Update UI Topbar and Mobile elements dynamically
        const sidebarNameEl = document.getElementById('sidebarUserName');
        const mobileSidebarNameEl = document.getElementById('mobileSidebarUserName');
        if (sidebarNameEl) sidebarNameEl.innerText = newName;
        if (mobileSidebarNameEl) mobileSidebarNameEl.innerText = newName;

        const renderAvatarEl = (el) => {
            if (!el) return;
            const initial = newName.charAt(0).toUpperCase();
            if (finalPhotoUrl) {
                el.innerHTML = `<img src="${finalPhotoUrl}" alt="${escapeHtml(newName)}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" onerror="this.onerror=null; this.parentElement.innerText='${initial}';">`;
            } else {
                el.innerHTML = '';
                el.innerText = initial;
            }
        };

        renderAvatarEl(document.getElementById('userAvatarCircle'));
        renderAvatarEl(document.getElementById('mobileUserAvatarCircle'));

        // Update welcome greeting banner
        const firstName = newName.split(' ')[0];
        const welcomeTitleEl = document.getElementById('welcomeTitle') || document.querySelector('.greeting-title');
        if (welcomeTitleEl) {
            const hour = new Date().getHours();
            let greeting = "Good morning";
            if (hour >= 12 && hour < 17) greeting = "Good afternoon";
            else if (hour >= 17 || hour < 5) greeting = "Good evening";
            welcomeTitleEl.innerText = `${greeting}, ${firstName} 👋`;
        }

        showTeacherModalAlert("Profile updated successfully!", "success");

        // Close modal after brief success display
        setTimeout(() => {
            window.closeTeacherProfileModal();
        }, 1200);

    } catch (err) {
        console.error("Error saving teacher profile:", err);

        if (err.code === 'auth/requires-recent-login') {
            showTeacherModalAlert("For security reasons, changing your email or password requires a recent login. Please log out, sign in again, and retry.", "error");
        } else if (err.code === 'auth/email-already-in-use') {
            showTeacherModalAlert("This email address is already in use by another account.", "error");
        } else if (err.code === 'auth/invalid-email') {
            showTeacherModalAlert("The email address is invalid.", "error");
        } else if (err.code === 'auth/weak-password') {
            showTeacherModalAlert("Password is too weak. Please use at least 6 characters.", "error");
        } else {
            showTeacherModalAlert(err.message || "Failed to save profile changes. Please try again.", "error");
        }
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<span>Save Changes</span>`;
        }
    }
};

// ==========================================
// --- ASSIGNMENT REMINDER SYSTEM (ADMIN) ---
// ==========================================

let cachedAssignmentReminders = [];
let reminderListenerUnsubscribe = null;
let reminderListenersInitialized = false;

window.switchManageScoreSubtab = function (subtabName) {
    if (!subtabName) subtabName = 'score-input';

    const btnScores = document.getElementById('btnManageScoreScores');
    const btnReminder = document.getElementById('btnManageScoreReminder');
    const subBtnScores = document.getElementById('subtabScoreInput');
    const subBtnReminder = document.getElementById('subtabAssignmentReminder');
    const secScores = document.getElementById('sectionManageScoreInput');
    const secReminder = document.getElementById('sectionAssignmentReminder');

    if (subtabName === 'assignment-reminder') {
        if (btnScores) btnScores.classList.remove('active');
        if (btnReminder) btnReminder.classList.add('active');
        if (subBtnScores) subBtnScores.classList.remove('active');
        if (subBtnReminder) subBtnReminder.classList.add('active');

        if (secScores) {
            secScores.classList.add('hidden');
            secScores.style.display = 'none';
        }
        if (secReminder) {
            secReminder.classList.remove('hidden');
            secReminder.style.display = 'block';
        }

        initAssignmentReminderTab();
    } else {
        if (btnScores) btnScores.classList.add('active');
        if (btnReminder) btnReminder.classList.remove('active');
        if (subBtnScores) subBtnScores.classList.add('active');
        if (subBtnReminder) subBtnReminder.classList.remove('active');

        if (secScores) {
            secScores.classList.remove('hidden');
            secScores.style.display = 'block';
        }
        if (secReminder) {
            secReminder.classList.add('hidden');
            secReminder.style.display = 'none';
        }
    }
};

function initAssignmentReminderTab() {
    // 1. Set default due date to tomorrow if empty
    const dueInput = document.getElementById('reminderDueDateInput');
    if (dueInput && !dueInput.value) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dueInput.value = tomorrow.toISOString().split('T')[0];
    }

    // 2. Populate Dropdowns
    populateAssignmentReminderDropdowns();
    const directSubSelect = document.getElementById('directSubjectSelect');
    if ((!directSubSelect || directSubSelect.options.length <= 1) && typeof window.loadSystemDatabases === 'function') {
        window.loadSystemDatabases();
    }

    // 3. Initialize Event Listeners (once)
    if (!reminderListenersInitialized) {
        reminderListenersInitialized = true;

        const subSelect = document.getElementById('reminderSubjectSelect');
        const classSelect = document.getElementById('reminderClassSelect');
        const assignSelect = document.getElementById('reminderAssignmentSelect');

        subSelect?.addEventListener('change', () => {
            loadReminderAssignments();
        });

        classSelect?.addEventListener('change', () => {
            loadReminderAssignments();
            loadReminderStudents();
        });

        assignSelect?.addEventListener('change', () => {
            const customWrapper = document.getElementById('reminderCustomAssignmentWrapper');
            if (customWrapper) {
                if (assignSelect.value === '__custom__') {
                    customWrapper.classList.remove('hidden');
                    document.getElementById('reminderCustomAssignmentInput')?.focus();
                } else {
                    customWrapper.classList.add('hidden');
                }
            }
        });

        // Search student input
        document.getElementById('reminderStudentSearchInput')?.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            const items = document.querySelectorAll('.reminder-student-item');
            items.forEach(item => {
                const text = item.textContent.toLowerCase();
                item.style.display = text.includes(query) ? 'flex' : 'none';
            });
        });

        // Select All / Deselect All
        document.getElementById('reminderSelectAllBtn')?.addEventListener('click', () => {
            document.querySelectorAll('.reminder-student-cb').forEach(cb => {
                const parent = cb.closest('.reminder-student-item');
                if (!parent || parent.style.display !== 'none') {
                    cb.checked = true;
                }
            });
            updateReminderSelectedCount();
        });

        document.getElementById('reminderDeselectAllBtn')?.addEventListener('click', () => {
            document.querySelectorAll('.reminder-student-cb').forEach(cb => cb.checked = false);
            updateReminderSelectedCount();
        });

        // Deploy Reminders Button
        document.getElementById('btnDeployReminders')?.addEventListener('click', deployAssignmentReminders);

        // Tracker Table Filters
        document.getElementById('filterReminderClass')?.addEventListener('change', renderAssignmentRemindersTable);
        document.getElementById('filterReminderSubject')?.addEventListener('change', renderAssignmentRemindersTable);
        document.getElementById('filterReminderStatus')?.addEventListener('change', renderAssignmentRemindersTable);
        document.getElementById('filterReminderSearch')?.addEventListener('input', debounce(renderAssignmentRemindersTable, 150));
        document.getElementById('refreshRemindersBtn')?.addEventListener('click', () => {
            listenAssignmentReminders();
        });
    }

    // 4. Start real-time listener for reminder ledger
    listenAssignmentReminders();
}

function populateAssignmentReminderDropdowns() {
    const subSelect = document.getElementById('reminderSubjectSelect');
    const classSelect = document.getElementById('reminderClassSelect');
    const filterSub = document.getElementById('filterReminderSubject');
    const filterClass = document.getElementById('filterReminderClass');

    // Populate from directSelect options if available
    const directSubSelect = document.getElementById('directSubjectSelect');
    const directClassSelect = document.getElementById('directClassSelect');

    if (subSelect && directSubSelect && directSubSelect.options.length > 1) {
        subSelect.innerHTML = directSubSelect.innerHTML;
        if (userRole !== 'admin' && teacherSubject) {
            subSelect.value = teacherSubject;
        }
    }

    if (filterSub && directSubSelect && directSubSelect.options.length > 1) {
        let opts = '<option value="">All Subjects</option>';
        for (let i = 0; i < directSubSelect.options.length; i++) {
            const opt = directSubSelect.options[i];
            if (opt.value) opts += `<option value="${opt.value}">${opt.text}</option>`;
        }
        filterSub.innerHTML = opts;
    }

    if (classSelect && directClassSelect && directClassSelect.options.length > 1) {
        classSelect.innerHTML = directClassSelect.innerHTML;
    }

    if (filterClass && directClassSelect && directClassSelect.options.length > 1) {
        let opts = '<option value="">All Classes</option>';
        for (let i = 0; i < directClassSelect.options.length; i++) {
            const opt = directClassSelect.options[i];
            if (opt.value) opts += `<option value="${opt.value}">${opt.text}</option>`;
        }
        filterClass.innerHTML = opts;
    }
}

async function loadReminderAssignments() {
    const subSelect = document.getElementById('reminderSubjectSelect');
    const classSelect = document.getElementById('reminderClassSelect');
    const assignSelect = document.getElementById('reminderAssignmentSelect');

    if (!assignSelect) return;

    const selectedSubject = subSelect ? subSelect.value.trim().toLowerCase() : "";
    const selectedClass = classSelect ? classSelect.value.trim().toLowerCase() : "";

    assignSelect.innerHTML = '<option value="">-- Select Assignment --</option>';

    if (!selectedSubject || !selectedClass) {
        assignSelect.innerHTML = '<option value="">-- Choose Subject & Class First --</option>';
        return;
    }

    const seenTitles = new Set();

    try {
        // 1. Digital Quizzes
        try {
            const digitalSnap = await getDocs(collection(db, "quizzes"));
            digitalSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.title || data.quizName || "").trim();
                const qSubject = (data.subject || "").trim().toLowerCase();
                const qClass = (data.targetClass || "").trim().toLowerCase();
                const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

                const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject) || qSubject.includes(selectedSubject);
                const matchesClass = !qClass ||
                    qClass === selectedClass ||
                    qClass === "all classes" ||
                    qClass === "all" ||
                    qClass.includes("all classes") ||
                    qClass.includes("all") ||
                    qClass.includes(selectedClass) ||
                    targetList.includes(selectedClass);

                if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                    seenTitles.add(title.toLowerCase());
                    assignSelect.innerHTML += `<option value="${escapeHtml(title)}">${escapeHtml(title)} (Digital Quiz)</option>`;
                }
            });
        } catch (err) {
            console.warn("Could not read digital quizzes for reminder:", err.message);
        }

        // 2. Offline & Classroom Quizzes from system_quizzes
        try {
            const manualSnap = await getDocs(collection(db, "system_quizzes"));
            manualSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.name || "").trim();
                const qSubject = (data.subject || "").trim().toLowerCase();
                const qClass = (data.targetClass || "").trim().toLowerCase();
                const targetList = Array.isArray(data.targetClassesList) ? data.targetClassesList.map(c => c.toLowerCase()) : [];

                const matchesSubject = !qSubject || qSubject === selectedSubject || selectedSubject.includes(qSubject) || qSubject.includes(selectedSubject);
                const matchesClass = !qClass ||
                    qClass === selectedClass ||
                    qClass === "all classes" ||
                    qClass === "all" ||
                    qClass.includes("all classes") ||
                    qClass.includes("all") ||
                    qClass.includes(selectedClass) ||
                    targetList.includes(selectedClass);

                if (title && matchesSubject && matchesClass && !seenTitles.has(title.toLowerCase())) {
                    seenTitles.add(title.toLowerCase());
                    const tag = (data.source === "google_classroom" || data.gclassCourseWorkId) ? "Classroom Assignment" : "Offline Assignment";
                    assignSelect.innerHTML += `<option value="${escapeHtml(title)}">${escapeHtml(title)} (${tag})</option>`;
                }
            });
        } catch (err) {
            console.warn("Could not read system_quizzes for reminder:", err.message);
        }

        // 3. Fallback: Existing exam_scores titles
        try {
            const scoresSnap = await getDocs(collection(db, "exam_scores"));
            scoresSnap.forEach(docSnap => {
                const data = docSnap.data();
                const title = (data.examName || data.quizName || "").trim();
                const docSubj = (data.subject || "").trim().toLowerCase();
                const docClass = (data.studentClass || "").trim().toLowerCase();

                if (title && (docSubj === selectedSubject || !selectedSubject) && (docClass === selectedClass || !selectedClass)) {
                    if (!seenTitles.has(title.toLowerCase())) {
                        seenTitles.add(title.toLowerCase());
                        assignSelect.innerHTML += `<option value="${escapeHtml(title)}">${escapeHtml(title)} (Score Record)</option>`;
                    }
                }
            });
        } catch (err) {
            console.warn("Could not read exam scores for reminder:", err.message);
        }

    } catch (e) {
        console.error("Error loading reminder assignments:", e);
    }

    // Always add Custom Option
    assignSelect.innerHTML += `<option value="__custom__">+ Enter Custom Assignment Name...</option>`;
}

async function loadReminderStudents() {
    const classSelect = document.getElementById('reminderClassSelect');
    const container = document.getElementById('reminderStudentListContainer');
    if (!container) return;

    const selectedClass = classSelect ? classSelect.value.trim() : "";
    if (!selectedClass) {
        container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-gray); padding: 20px; font-size: 13px;">Please select a Class above to load students.</div>`;
        updateReminderSelectedCount();
        return;
    }

    container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--primary-blue); padding: 20px; font-size: 13px;">Loading students for Class ${escapeHtml(selectedClass)}...</div>`;

    try {
        const q = query(collection(db, "students"), where("studentClass", "==", selectedClass));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: #ef4444; padding: 20px; font-size: 13px;">No students found in Class ${escapeHtml(selectedClass)}.</div>`;
            updateReminderSelectedCount();
            return;
        }

        const studentsList = [];
        snap.forEach(docSnap => {
            const d = docSnap.data();
            studentsList.push({
                code: (d.studentCode || docSnap.id).toString().trim().toUpperCase(),
                name: d.studentName || d.name || "Student",
                studentClass: d.studentClass || selectedClass,
                photoUrl: d.photoUrl || d.photo || null
            });
        });

        // Sort alphabetically by name
        studentsList.sort((a, b) => a.name.localeCompare(b.name));

        let html = '';
        studentsList.forEach(s => {
            const initial = (s.name.charAt(0) || 'S').toUpperCase();
            const avatarHtml = s.photoUrl
                ? `<img src="${s.photoUrl}" alt="${escapeHtml(s.name)}" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover;">`
                : `<div style="width: 28px; height: 28px; border-radius: 50%; background: #1e5eff; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center;">${initial}</div>`;

            html += `
                <label class="reminder-student-item" style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--card-bg, #ffffff); border: 1px solid var(--border-color, #e2e8f0); border-radius: 9px; cursor: pointer; transition: background 0.15s; user-select: none;">
                    <input type="checkbox" class="reminder-student-cb" value="${escapeHtml(s.code)}" data-name="${escapeHtml(s.name)}" data-class="${escapeHtml(s.studentClass)}" onchange="updateReminderSelectedCount()" style="width: 16px; height: 16px; accent-color: var(--primary-blue, #1e5eff); cursor: pointer;">
                    ${avatarHtml}
                    <div style="overflow: hidden; line-height: 1.2; flex: 1;">
                        <div style="font-size: 13px; font-weight: 700; color: var(--text-dark); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(s.name)}</div>
                        <div style="font-size: 11px; color: var(--text-gray); font-family: monospace;">${escapeHtml(s.code)}</div>
                    </div>
                </label>
            `;
        });

        container.innerHTML = html;
        updateReminderSelectedCount();

    } catch (err) {
        console.error("Error loading students for reminder:", err);
        container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: #ef4444; padding: 20px; font-size: 13px;">Error loading students: ${escapeHtml(err.message)}</div>`;
    }
}

function updateReminderSelectedCount() {
    const badge = document.getElementById('reminderStudentCountBadge');
    if (!badge) return;
    const total = document.querySelectorAll('.reminder-student-cb:checked').length;
    badge.innerText = `${total} Selected`;
}

async function deployAssignmentReminders() {
    const subject = document.getElementById('reminderSubjectSelect')?.value.trim();
    const studentClass = document.getElementById('reminderClassSelect')?.value.trim();
    const assignmentVal = document.getElementById('reminderAssignmentSelect')?.value.trim();
    const customTitle = document.getElementById('reminderCustomAssignmentInput')?.value.trim();
    const dueDate = document.getElementById('reminderDueDateInput')?.value.trim();
    const notes = document.getElementById('reminderNotesInput')?.value.trim() || '';

    const assignmentTitle = assignmentVal === '__custom__' ? customTitle : assignmentVal;

    if (!subject) return alert("Please select a Subject.");
    if (!studentClass) return alert("Please select a Class.");
    if (!assignmentTitle) return alert("Please select or enter an Assignment Name.");
    if (!dueDate) return alert("Please specify a Submission Due Date.");

    // Collect checked students
    const checkedCheckboxes = document.querySelectorAll('.reminder-student-cb:checked');
    if (checkedCheckboxes.length === 0) {
        return alert("Please select at least one student to receive this reminder.");
    }

    const studentsToRemind = [];
    checkedCheckboxes.forEach(cb => {
        studentsToRemind.push({
            code: cb.value,
            name: cb.getAttribute('data-name') || 'Student',
            studentClass: cb.getAttribute('data-class') || studentClass
        });
    });

    if (!confirm(`Deploy reminder for ${studentsToRemind.length} student(s) for "${assignmentTitle}" (Due: ${dueDate})?`)) {
        return;
    }

    const deployBtn = document.getElementById('btnDeployReminders');
    if (deployBtn) {
        deployBtn.disabled = true;
        deployBtn.innerHTML = `<span>Deploying ${studentsToRemind.length} Reminders...</span>`;
    }

    try {
        const createdBy = auth.currentUser?.email || "Teacher";
        const nowIso = new Date().toISOString();

        // Write each reminder document to Firestore
        const writePromises = studentsToRemind.map(s => {
            return addDoc(collection(db, "assignment_reminders"), {
                studentCode: s.code.toUpperCase(),
                studentName: s.name,
                studentClass: s.studentClass,
                subject: subject,
                assignmentTitle: assignmentTitle,
                dueDate: dueDate,
                notes: notes,
                status: "pending",
                createdBy: createdBy,
                createdAt: nowIso,
                completedAt: null
            });
        });

        await Promise.all(writePromises);

        alert(`Successfully deployed ${studentsToRemind.length} reminder(s) for "${assignmentTitle}"!`);

        // Uncheck all students
        document.querySelectorAll('.reminder-student-cb').forEach(cb => cb.checked = false);
        updateReminderSelectedCount();

    } catch (err) {
        console.error("Error deploying reminders:", err);
        alert("Failed to deploy reminders: " + err.message);
    } finally {
        if (deployBtn) {
            deployBtn.disabled = false;
            deployBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 2L11 13"></path>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
                <span>Deploy Assignment Reminder</span>`;
        }
    }
}

function getDaysLate(dueDateStr) {
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

function listenAssignmentReminders() {
    if (reminderListenerUnsubscribe) {
        reminderListenerUnsubscribe();
    }

    try {
        const q = collection(db, "assignment_reminders");
        reminderListenerUnsubscribe = onSnapshot(q, (snapshot) => {
            cachedAssignmentReminders = [];
            snapshot.forEach(docSnap => {
                cachedAssignmentReminders.push({
                    id: docSnap.id,
                    ...docSnap.data()
                });
            });
            renderAssignmentRemindersTable();
        }, (err) => {
            console.error("Assignment reminders snapshot error:", err);
        });
    } catch (e) {
        console.error("Failed to attach assignment reminders listener:", e);
    }
}

function renderAssignmentRemindersTable() {
    const tbody = document.getElementById('assignmentReminderTbody');
    if (!tbody) return;

    const filterClass = (document.getElementById('filterReminderClass')?.value || "").toLowerCase().trim();
    const filterSubject = (document.getElementById('filterReminderSubject')?.value || "").toLowerCase().trim();
    const filterStatus = document.getElementById('filterReminderStatus')?.value || "pending";
    const filterSearch = (document.getElementById('filterReminderSearch')?.value || "").toLowerCase().trim();

    let filtered = cachedAssignmentReminders.filter(r => {
        if (filterClass && (r.studentClass || "").toLowerCase() !== filterClass) return false;
        if (filterSubject && (r.subject || "").toLowerCase() !== filterSubject) return false;
        if (filterStatus !== 'all') {
            if (filterStatus === 'pending' && r.status !== 'pending') return false;
            if (filterStatus === 'completed' && r.status !== 'completed') return false;
        }
        if (filterSearch) {
            const matchName = (r.studentName || "").toLowerCase().includes(filterSearch);
            const matchCode = (r.studentCode || "").toLowerCase().includes(filterSearch);
            const matchTitle = (r.assignmentTitle || "").toLowerCase().includes(filterSearch);
            if (!matchName && !matchCode && !matchTitle) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-gray);">No assignment reminders match your filters.</td></tr>`;
        return;
    }

    // Sort by status (pending first), then by days late (most overdue first), then by student name
    filtered.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        const lateA = getDaysLate(a.dueDate);
        const lateB = getDaysLate(b.dueDate);
        if (lateA !== lateB) return lateB - lateA;
        return (a.studentName || "").localeCompare(b.studentName || "");
    });

    let html = '';
    filtered.forEach(item => {
        const daysLate = getDaysLate(item.dueDate);
        let dueDisplay = `<span style="font-weight: 600;">${escapeHtml(item.dueDate || 'No date')}</span>`;

        if (item.status === 'completed') {
            dueDisplay += ` <span style="background: rgba(16, 185, 129, 0.12); color: #10b981; font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 4px; margin-left: 6px; display: inline-flex; align-items: center; gap: 3px;">✓ Submitted</span>`;
        } else if (daysLate > 1) {
            dueDisplay += ` <strong style="color: #ef4444; font-size: 11.5px; margin-left: 6px; background: rgba(239, 68, 68, 0.1); padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.3);">🚨 ${daysLate}d Overdue</strong>`;
        } else if (daysLate === 1) {
            dueDisplay += ` <strong style="color: #ea580c; font-size: 11.5px; margin-left: 6px; background: rgba(249, 115, 22, 0.1); padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(249, 115, 22, 0.3);">⚠️ 1d Overdue</strong>`;
        } else if (daysLate === 0) {
            dueDisplay += ` <strong style="color: #d97706; font-size: 11.5px; margin-left: 6px; background: rgba(245, 158, 11, 0.1); padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.3);">⏳ Due Today</strong>`;
        } else {
            const inDays = Math.abs(daysLate);
            dueDisplay += ` <span style="color: var(--primary-blue); font-size: 11.5px; margin-left: 6px;">(in ${inDays}d)</span>`;
        }

        const isCompleted = item.status === 'completed';

        html += `
            <tr style="${isCompleted ? 'opacity: 0.65;' : ''}">
                <td>
                    <div style="font-weight: 700; color: var(--text-dark);">${escapeHtml(item.studentName || 'Student')}</div>
                    <div style="font-size: 11px; color: var(--text-gray); font-family: monospace;">${escapeHtml(item.studentCode || '')}</div>
                </td>
                <td><span style="font-weight: 600;">${escapeHtml(item.studentClass || '')}</span></td>
                <td><span style="background: rgba(30,94,255,0.08); color: var(--primary-blue); padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 11.5px;">${escapeHtml(item.subject || '')}</span></td>
                <td>
                    <div style="font-weight: 700; color: var(--text-dark);">${escapeHtml(item.assignmentTitle || '')}</div>
                    ${item.notes ? `<div style="font-size: 11px; color: var(--text-gray); font-style: italic;">${escapeHtml(item.notes)}</div>` : ''}
                </td>
                <td>${dueDisplay}</td>
                <td style="text-align: center; position: relative;">
                    <div class="kebab-wrapper" style="position: relative; display: inline-block;">
                        <button type="button" class="kebab-btn" onclick="toggleReminderKebabMenu(event, '${item.id}')" title="Actions">
                            ⋮
                        </button>
                        <div id="reminder-kebab-${item.id}" class="kebab-dropdown">
                            <button type="button" class="kebab-item" onclick="toggleAssignmentReminderStatus('${item.id}', '${isCompleted ? 'pending' : 'completed'}')">
                                <span style="font-size: 13px;">${isCompleted ? '↺' : '✓'}</span>
                                <span>${isCompleted ? 'Mark Pending' : 'Mark as Done'}</span>
                            </button>
                            <button type="button" class="kebab-item danger" onclick="deleteAssignmentReminder('${item.id}')">
                                <span style="font-size: 13px;">🗑</span>
                                <span>Delete Reminder</span>
                            </button>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

window.toggleReminderKebabMenu = function (e, id) {
    e.stopPropagation();
    const targetDropdown = document.getElementById(`reminder-kebab-${id}`);
    const isAlreadyOpen = targetDropdown && targetDropdown.classList.contains('show');

    document.querySelectorAll('.kebab-dropdown.show').forEach(d => {
        d.classList.remove('show');
    });

    if (targetDropdown && !isAlreadyOpen) {
        targetDropdown.classList.add('show');
    }
};

// Global click to dismiss kebab menus
document.addEventListener('click', (e) => {
    if (!e.target.closest('.kebab-wrapper') && !e.target.closest('.kebab-menu')) {
        document.querySelectorAll('.kebab-dropdown.show').forEach(d => {
            d.classList.remove('show');
        });
    }
});

window.toggleAssignmentReminderStatus = async function (reminderId, newStatus) {
    // Close open kebab dropdowns
    document.querySelectorAll('.kebab-dropdown.show').forEach(d => d.classList.remove('show'));
    try {
        await updateDoc(doc(db, "assignment_reminders", reminderId), {
            status: newStatus,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : null
        });
    } catch (e) {
        alert("Error updating reminder status: " + e.message);
    }
};

window.deleteAssignmentReminder = async function (reminderId) {
    // Close open kebab dropdowns
    document.querySelectorAll('.kebab-dropdown.show').forEach(d => d.classList.remove('show'));
    if (!confirm("Are you sure you want to delete this assignment reminder?")) return;
    try {
        await deleteDoc(doc(db, "assignment_reminders", reminderId));
    } catch (e) {
        alert("Error deleting reminder: " + e.message);
    }
};

window.updateReminderSelectedCount = updateReminderSelectedCount;
window.populateAssignmentReminderDropdowns = populateAssignmentReminderDropdowns;

