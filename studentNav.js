// studentNav.js - Global Mobile Kebab Menu Navigation Handler
const initMobileNav = () => {
    const kebabBtn = document.getElementById('mobileTopbarKebabBtn');
    const dropdown = document.getElementById('mobileTopbarDropdown');
    const kebabThemeBtn = document.getElementById('mobileKebabThemeBtn');
    const kebabThemeText = document.getElementById('mobileKebabThemeText');
    const kebabLogoutBtn = document.getElementById('mobileKebabLogoutBtn');

    if (!kebabBtn || !dropdown) return;

    // Toggle Dropdown on click/tap
    kebabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !kebabBtn.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });

    // Handle clicks inside dropdown (tabs & links)
    dropdown.querySelectorAll('.kebab-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const tabId = item.getAttribute('data-tab');
            if (tabId) {
                // If it's a tab switch button in admin dashboard
                const desktopBtn = document.querySelector(`.menu-bar [data-tab="${tabId}"]`);
                if (desktopBtn) {
                    desktopBtn.click();
                } else {
                    document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
                    const targetTab = document.getElementById(tabId);
                    if (targetTab) targetTab.classList.add('active');
                    if (tabId === 'tab-manage-quizzes' && typeof window.loadQuizzesTable === 'function') {
                        window.loadQuizzesTable();
                    }
                }

                const subtab = item.getAttribute('data-subtab');
                if (subtab && tabId === 'tab-manage-scores' && typeof window.switchManageScoreSubtab === 'function') {
                    window.switchManageScoreSubtab(subtab);
                } else if (subtab && typeof window.switchDbView === 'function') {
                    window.switchDbView(subtab);
                }

                dropdown.querySelectorAll('.kebab-item[data-tab]').forEach(k => k.classList.remove('active'));
                item.classList.add('active');
            }
            dropdown.classList.add('hidden');
        });
    });

    // Highlight current active tab in mobile kebab menu for student portal
    const currentPath = window.location.pathname.split('/').pop() || 'index.html';
    const navDashboard = dropdown.querySelector('.nav-dashboard');
    const navQuiz = dropdown.querySelector('.nav-quiz');
    const navTimeline = dropdown.querySelector('.nav-timeline');
    const navBoard = dropdown.querySelector('.nav-board');
    const navScores = dropdown.querySelector('.nav-scores');
    const navProfile = dropdown.querySelector('.nav-profile');

    const navWeekly = dropdown.querySelector('.nav-weekly');

    if (currentPath === 'index.html' || currentPath === '') {
        navDashboard?.classList.add('active');
    } else if (currentPath === 'quiz.html') {
        navQuiz?.classList.add('active');
    } else if (currentPath === 'timeline.html') {
        navTimeline?.classList.add('active');
    } else if (currentPath === 'board.html') {
        navBoard?.classList.add('active');
    } else if (currentPath === 'scores.html') {
        navScores?.classList.add('active');
    } else if (currentPath === 'profile.html') {
        navProfile?.classList.add('active');
    } else if (currentPath === 'weekly.html') {
        navWeekly?.classList.add('active');
    }

    // Sync active state when desktop menu buttons are clicked (for admin.html)
    document.querySelectorAll('.menu-bar .menu-btn').forEach(dBtn => {
        dBtn.addEventListener('click', () => {
            const tabId = dBtn.getAttribute('data-tab');
            if (tabId) {
                dropdown.querySelectorAll('.kebab-item[data-tab]').forEach(k => {
                    k.classList.toggle('active', k.getAttribute('data-tab') === tabId);
                });
            }
        });
    });

    // Sync Dark Mode Toggle
    const updateThemeText = () => {
        const isDark = document.body.classList.contains('dark-theme') || document.body.classList.contains('dark-mode');
        if (kebabThemeText) {
            kebabThemeText.textContent = isDark ? 'Light Mode' : 'Dark Mode';
        }
        const desktopThemeText = document.getElementById('mainThemeText') || document.getElementById('adminThemeText');
        if (desktopThemeText) {
            desktopThemeText.textContent = isDark ? 'Light Mode' : 'Dark Mode';
        }
        document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.setProperty('display', isDark ? 'inline-block' : 'none', 'important'));
        document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.setProperty('display', isDark ? 'none' : 'inline-block', 'important'));
    };
    updateThemeText();

    if (kebabThemeBtn) {
        kebabThemeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const desktopThemeBtn = document.getElementById('themeToggleBtn') || document.getElementById('darkModeToggle');
            if (desktopThemeBtn && desktopThemeBtn !== kebabThemeBtn) {
                desktopThemeBtn.click();
            } else {
                const isDark = document.body.classList.toggle('dark-theme');
                document.body.classList.toggle('dark-mode', isDark);
                localStorage.setItem('appTheme', isDark ? 'dark' : 'light');
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
            }
            updateThemeText();
        });
    }

    // Sync Logout
    if (kebabLogoutBtn) {
        kebabLogoutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const adminLogoutBtn = document.getElementById('logoutBtn');
            const studentLogoutBtn = document.getElementById('studentLogoutBtn');
            if (adminLogoutBtn) {
                adminLogoutBtn.click();
            } else if (studentLogoutBtn) {
                studentLogoutBtn.click();
            } else {
                localStorage.removeItem('loggedInStudentCode');
                localStorage.removeItem('studentLoggedIn');
                sessionStorage.removeItem('studentLoggedInSession');
                window.location.href = 'index.html';
            }
        });
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileNav);
} else {
    initMobileNav();
}
