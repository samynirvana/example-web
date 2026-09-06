import { collection, query, where, getDocs, doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./utils.js";

let currentStudentCode = "";
let currentStudentName = "";
let currentPhotoUrl = "";

// --- THEME SYNC ---
const themeToggleBtn = document.getElementById('themeToggleBtn');
const mainThemeText = document.getElementById('mainThemeText');
const savedTheme = localStorage.getItem('appTheme') || 'light';

function applyProfileTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);
    document.body.classList.toggle('dark-mode', isDark);
    if (mainThemeText) mainThemeText.innerText = isDark ? 'Light Mode' : 'Dark Mode';
    document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
    document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
}

applyProfileTheme(savedTheme);

themeToggleBtn?.addEventListener('click', () => {
    const isDark = !document.body.classList.contains('dark-theme');
    const newTheme = isDark ? 'dark' : 'light';
    localStorage.setItem('appTheme', newTheme);
    localStorage.setItem('theme', newTheme);
    applyProfileTheme(newTheme);
});

// --- LOGOUT HANDLER ---
const logoutBtn = document.getElementById('studentLogoutBtn');
logoutBtn?.addEventListener('click', () => {
    sessionStorage.removeItem('studentLoggedInSession');
    sessionStorage.removeItem('studentTimelineSession');
    localStorage.removeItem('loggedInStudentCode');
    window.location.href = 'index.html';
});

// --- KEBAB & MODAL CONTROLS ---
window.toggleProfileCardMenu = function(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('profileCardDropdown');
    if (menu) menu.classList.toggle('hidden');
};

window.openPhotoEditModal = function() {
    const menu = document.getElementById('profileCardDropdown');
    if (menu) menu.classList.add('hidden');

    const modal = document.getElementById('photoEditModal');
    const modalName = document.getElementById('modalStudentName');
    const modalCode = document.getElementById('modalStudentCode');
    const modalAvatarImg = document.getElementById('modalAvatarImg');
    const modalAvatarFallback = document.getElementById('modalAvatarFallback');

    if (modalName) modalName.innerText = currentStudentName || 'Student';
    if (modalCode) modalCode.innerText = currentStudentCode || '-----';

    if (currentPhotoUrl) {
        if (modalAvatarImg) {
            modalAvatarImg.src = currentPhotoUrl;
            modalAvatarImg.classList.remove('hidden');
        }
        if (modalAvatarFallback) modalAvatarFallback.classList.add('hidden');
    } else {
        if (modalAvatarImg) modalAvatarImg.classList.add('hidden');
        if (modalAvatarFallback) modalAvatarFallback.classList.remove('hidden');
    }

    if (modal) modal.classList.remove('hidden');
};

let currentBirthDate = '';

window.closePhotoEditModal = function() {
    const modal = document.getElementById('photoEditModal');
    if (modal) modal.classList.add('hidden');
};

window.triggerStudentPhotoInput = function() {
    document.getElementById('studentPhotoInput')?.click();
};

// Toggle DOB Kebab Menu
window.toggleDobMenu = function (e) {
    e?.stopPropagation();
    const dropdown = document.getElementById('dobKebabDropdown');
    if (dropdown) {
        dropdown.classList.toggle('hidden');
    }
};

window.openDobModal = function (e) {
    e?.stopPropagation();
    const dropdown = document.getElementById('dobKebabDropdown');
    if (dropdown) {
        dropdown.classList.add('hidden');
    }

    const input = document.getElementById('studentDobInput');
    if (input) {
        input.value = currentBirthDate || '';
    }

    const modal = document.getElementById('dobEditModal');
    if (modal) modal.classList.remove('hidden');
};

window.closeDobModal = function () {
    const modal = document.getElementById('dobEditModal');
    if (modal) modal.classList.add('hidden');
};

window.saveStudentDob = async function (e) {
    e.preventDefault();
    const input = document.getElementById('studentDobInput');
    const newDob = input?.value.trim() || '';
    const saveBtn = document.getElementById('btnSaveDob');

    if (!currentStudentCode) {
        showToast('Student code not found.', false);
        return;
    }

    try {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerText = 'Saving...';
        }

        // 1. Update Firestore student document
        const studentRef = doc(db, "students", currentStudentCode);
        await updateDoc(studentRef, {
            birthDate: newDob,
            dateOfBirth: newDob
        });

        // 2. Update local session storage
        currentBirthDate = newDob;
        const rawSession = sessionStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession');
        if (rawSession) {
            try {
                const sessionObj = JSON.parse(rawSession);
                sessionObj.birthDate = newDob;
                sessionObj.dateOfBirth = newDob;
                sessionStorage.setItem('studentLoggedInSession', JSON.stringify(sessionObj));
            } catch (sErr) {
                console.warn(sErr);
            }
        }

        // 3. Update UI display
        document.getElementById('profileBirthDate').innerText = formatBirthDate(newDob);

        showToast('Date of birth updated successfully!', true);
        closeDobModal();
    } catch (err) {
        console.error("Error updating birth date:", err);
        showToast('Error saving date of birth: ' + err.message, false);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = 'Save Date';
        }
    }
};

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('profileCardDropdown');
    const btn = document.getElementById('profileCardKebabBtn');
    if (menu && !menu.classList.contains('hidden')) {
        if (!menu.contains(e.target) && !btn?.contains(e.target)) {
            menu.classList.add('hidden');
        }
    }

    const dobMenu = document.getElementById('dobKebabDropdown');
    const dobBtn = document.getElementById('btnDobKebab');
    if (dobMenu && !dobMenu.classList.contains('hidden')) {
        if (!dobMenu.contains(e.target) && !dobBtn?.contains(e.target)) {
            dobMenu.classList.add('hidden');
        }
    }
});

// --- FORMAT DATE HELPER ---
function formatBirthDate(dateStr) {
    if (!dateStr || dateStr.trim() === '') return 'Not Set';
    
    // Handle standard YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [year, month, day] = dateStr.split('-');
        const dateObj = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
        if (!isNaN(dateObj.getTime())) {
            const formatted = dateObj.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
            
            // Check if today is birthday
            const today = new Date();
            if (today.getMonth() === dateObj.getMonth() && today.getDate() === dateObj.getDate()) {
                return `${formatted} 🎂 (Happy Birthday!)`;
            }
            return formatted;
        }
    }
    
    return dateStr;
}

// Convert Google Drive share link to high-res embed link if needed
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

// Resize image to max 500x500 data URL for optimal speed & storage
function resizeImageToDataUrl(file, maxWidth = 500, maxHeight = 500, quality = 0.9) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Fetch Google Drive Script URL from Firestore or LocalStorage
async function getDriveScriptUrl() {
    let url = localStorage.getItem('profileDriveScriptUrl') || localStorage.getItem('googleDriveScriptUrl') || '';
    try {
        let snap = await getDoc(doc(db, "system_settings", "google_drive"));
        if (!snap.exists()) {
            snap = await getDoc(doc(db, "system_settings", "googleDrive"));
        }
        if (snap.exists()) {
            const data = snap.data();
            const profileScript = data.profileScriptUrl || data.scriptUrlProfile || data.scriptUrl;
            if (profileScript) {
                url = profileScript;
                localStorage.setItem('profileDriveScriptUrl', url);
                localStorage.setItem('googleDriveScriptUrl', url);
            }
            if (data.profileFolderId || data.folderIdProfile) {
                localStorage.setItem('profileDriveFolderId', data.profileFolderId || data.folderIdProfile);
            }
        }
    } catch (e) {
        console.warn("Could not fetch system_settings for Google Drive:", e);
    }
    return url;
}

// Upload photo to Google Drive
// The Apps Script checks if a photo named studentCode.jpg exists in the folder:
// - If exists: replaces the old photo safely
// - If not: adds new file and names it studentCode.jpg
async function uploadPhotoToGoogleDrive(file, dataUrl, scriptUrl, studentCode) {
    if (!scriptUrl) {
        throw new Error("Google Drive Web App URL is not configured yet. Please configure it in Admin Settings.");
    }
    
    const base64Data = dataUrl.split(',')[1];
    const fileName = `${studentCode}.jpg`;
    const folderId = localStorage.getItem('profileDriveFolderId') || '';

    const response = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
            fileName: fileName,
            studentCode: studentCode,
            mimeType: 'image/jpeg',
            base64Data: base64Data,
            folderName: "picdb",
            folderId: folderId,
            replaceExisting: true
        })
    });

    const resText = await response.text();
    let resJson;
    try {
        resJson = JSON.parse(resText);
    } catch (pErr) {
        console.error("Raw response from Apps Script:", resText);
        throw new Error("Invalid response received from Google Apps Script.");
    }

    const photoUrl = resJson.photoUrl || resJson.url || resJson.directUrl || (resJson.fileId ? `https://lh3.googleusercontent.com/d/${resJson.fileId}` : null);
    if (resJson.status === 'success' && photoUrl) {
        return photoUrl;
    } else {
        throw new Error(resJson.message || "Google Drive upload failed.");
    }
}

// Toast notification helper
function showToast(message, isSuccess = true) {
    const toast = document.getElementById('uploadStatusToast');
    const toastIcon = document.getElementById('toastIcon');
    const toastMessage = document.getElementById('toastMessage');
    if (!toast) return;

    if (toastIcon) toastIcon.innerText = isSuccess ? '✅' : '⚠️';
    if (toastMessage) toastMessage.innerText = message;

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3800);
}

// --- STUDENT PHOTO UPLOAD HANDLER ---
const studentPhotoInput = document.getElementById('studentPhotoInput');
studentPhotoInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file (.jpg, .png, .webp)', false);
        return;
    }

    const spinner = document.getElementById('avatarUploadSpinner');
    const avatarImg = document.getElementById('profileAvatarImg');
    const avatarFallback = document.getElementById('avatarFallback');
    const modalAvatarImg = document.getElementById('modalAvatarImg');
    const modalAvatarFallback = document.getElementById('modalAvatarFallback');
    const modalChangeBtn = document.getElementById('modalChangePhotoBtn');

    try {
        if (spinner) spinner.classList.remove('hidden');
        if (modalChangeBtn) {
            modalChangeBtn.disabled = true;
            modalChangeBtn.innerHTML = `<span>Processing the Image...</span>`;
        }

        // 1. Resize and optimize image for quick transfer
        const dataUrl = await resizeImageToDataUrl(file);

        // 2. Fetch configured Google Drive Web App Script URL
        const scriptUrl = await getDriveScriptUrl();

        // 3. Upload to Google Drive (Script checks for existing student code and replaces/adds)
        const finalUrl = await uploadPhotoToGoogleDrive(file, dataUrl, scriptUrl, currentStudentCode);
        currentPhotoUrl = finalUrl;

        // 4. Update Firestore Student Record with the Google Drive link
        const studentRef = doc(db, "students", currentStudentCode);
        await updateDoc(studentRef, {
            photoUrl: finalUrl
        });

        // 5. Update local session storage
        const rawSession = sessionStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession');
        if (rawSession) {
            try {
                const sessionObj = JSON.parse(rawSession);
                sessionObj.photoUrl = finalUrl;
                sessionObj.photo = finalUrl;
                sessionStorage.setItem('studentLoggedInSession', JSON.stringify(sessionObj));
            } catch (err) {
                console.warn(err);
            }
        }

        // 6. Update UI
        if (avatarImg) {
            avatarImg.src = finalUrl;
            avatarImg.classList.remove('hidden');
        }
        if (avatarFallback) avatarFallback.classList.add('hidden');

        if (modalAvatarImg) {
            modalAvatarImg.src = finalUrl;
            modalAvatarImg.classList.remove('hidden');
        }
        if (modalAvatarFallback) modalAvatarFallback.classList.add('hidden');

        showToast('Photo updated successfully!', true);

        // Close modal after brief success feedback
        setTimeout(() => {
            closePhotoEditModal();
        }, 700);

    } catch (err) {
        console.error("Error updating student photo to Google Drive:", err);
        showToast('Upload error: ' + err.message, false);
    } finally {
        if (spinner) spinner.classList.add('hidden');
        if (modalChangeBtn) {
            modalChangeBtn.disabled = false;
            modalChangeBtn.innerHTML = `<span>Change Photo</span>`;
        }
        studentPhotoInput.value = '';
    }
});

// --- LOAD PROFILE DATA ---
async function loadStudentProfile() {
    const rawSession = sessionStorage.getItem('studentLoggedInSession') || sessionStorage.getItem('studentTimelineSession');
    let studentCode = '';
    let cachedData = null;

    if (rawSession) {
        try {
            cachedData = JSON.parse(rawSession);
            studentCode = cachedData.code || cachedData.studentCode || cachedData.id || '';
        } catch (e) {
            console.error(e);
        }
    }

    if (!studentCode) {
        studentCode = localStorage.getItem('loggedInStudentCode') || '';
    }

    if (!studentCode) {
        window.location.href = 'index.html';
        return;
    }

    currentStudentCode = studentCode;

    try {
        // 1. Fetch Student from Firestore
        const studentRef = doc(db, "students", studentCode);
        const studentSnap = await getDoc(studentRef);

        let studentData = cachedData || {};
        if (studentSnap.exists()) {
            studentData = { ...studentSnap.data(), code: studentCode };
        }

        const name = studentData.studentName || studentData.name || 'Student';
        const sClass = studentData.studentClass || studentData.class || 'Unassigned';
        const birthDate = studentData.birthDate || studentData.dateOfBirth || '';
        const photoUrl = resolvePhotoUrl(studentData.photoUrl || studentData.photo || studentData.avatar || '');

        currentStudentName = name;
        currentPhotoUrl = photoUrl;
        currentBirthDate = birthDate;

        // 2. Render Text Elements
        document.getElementById('profileStudentName').innerText = name;
        document.getElementById('profileClassText').innerText = sClass;
        document.getElementById('profileCodeText').innerText = studentCode;
        document.getElementById('profileBirthDate').innerText = formatBirthDate(birthDate);

        // 3. Render Avatar Photo
        const avatarImg = document.getElementById('profileAvatarImg');
        const avatarFallback = document.getElementById('avatarFallback');

        if (photoUrl) {
            avatarImg.src = photoUrl;
            avatarImg.classList.remove('hidden');
            avatarFallback.classList.add('hidden');

            avatarImg.onerror = () => {
                avatarImg.classList.add('hidden');
                avatarFallback.classList.remove('hidden');
            };
        } else {
            avatarImg.classList.add('hidden');
            avatarFallback.classList.remove('hidden');
        }

        // 4. Fetch Total Behavior Points
        try {
            const pointsQuery = query(collection(db, "student_points"), where("studentCode", "==", studentCode));
            const pointsSnap = await getDocs(pointsQuery);
            let totalPoints = 0;
            pointsSnap.forEach(pDoc => {
                const pData = pDoc.data();
                totalPoints += (parseInt(pData.points, 10) || 0);
            });
            document.getElementById('profilePoints').innerText = `${totalPoints} Pts`;
        } catch (pe) {
            console.warn("Could not load points", pe);
        }

    } catch (err) {
        console.error("Error loading student profile:", err);
        document.getElementById('profileStudentName').innerText = cachedData?.name || 'Student';
    }
}

window.addEventListener('DOMContentLoaded', loadStudentProfile);
