#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stddef.h>
#include <string.h>

#define PATH_CAPACITY 32768
#define COMMAND_CAPACITY 32767
#define EXTENSION_ID_CAPACITY 34
#define EXTENSION_DEFAULT_ID L"ghppfgfeoafdcaebjoglabppkfmbcjdd"
#define EXTENSION_SOURCE L"https://update.doufen.org/*"

static WCHAR g_executable[PATH_CAPACITY];
static WCHAR g_directory[PATH_CAPACITY];
static WCHAR g_chromePath[PATH_CAPACITY];
static WCHAR g_userDataPath[PATH_CAPACITY];
static WCHAR g_configPath[PATH_CAPACITY];
static WCHAR g_extensionId[EXTENSION_ID_CAPACITY];

static BOOL AppendWide(WCHAR *destination, size_t capacity, const WCHAR *source)
{
    size_t used = wcslen(destination), added = wcslen(source);
    if (used >= capacity || added >= capacity - used) {
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    memcpy(destination + used, source, (added + 1) * sizeof(WCHAR));
    return TRUE;
}

static BOOL PathBesideLauncher(WCHAR *destination, const WCHAR *relativePath)
{
    destination[0] = L'\0';
    return AppendWide(destination, PATH_CAPACITY, g_directory) &&
           AppendWide(destination, PATH_CAPACITY, relativePath);
}

static BOOL InitializePaths(void)
{
    DWORD length = GetModuleFileNameW(NULL, g_executable, PATH_CAPACITY);
    if (length == 0) return FALSE;
    if (length >= PATH_CAPACITY) {
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    memcpy(g_directory, g_executable, (length + 1) * sizeof(WCHAR));
    WCHAR *lastSlash = wcsrchr(g_directory, L'\\');
    if (!lastSlash) {
        SetLastError(ERROR_BAD_PATHNAME);
        return FALSE;
    }
    lastSlash[1] = L'\0';
    return PathBesideLauncher(g_chromePath, L"chrome\\chrome.exe") &&
           PathBesideLauncher(g_userDataPath, L"userdata") &&
           PathBesideLauncher(g_configPath, L"config.ini");
}

static BOOL LoadSettings(void)
{
    DWORD length = GetPrivateProfileStringW(L"extension", L"id", EXTENSION_DEFAULT_ID,
        g_extensionId, EXTENSION_ID_CAPACITY, g_configPath);
    if (length != 32) {
        SetLastError(ERROR_INVALID_DATA);
        return FALSE;
    }
    for (DWORD index = 0; index < length; ++index) {
        if (g_extensionId[index] < L'a' || g_extensionId[index] > L'p') {
            SetLastError(ERROR_INVALID_DATA);
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL IsFirstRun(void)
{
    WCHAR extensionPath[PATH_CAPACITY];
    if (!PathBesideLauncher(extensionPath, L"userdata\\Default\\Extensions\\") ||
        !AppendWide(extensionPath, PATH_CAPACITY, g_extensionId)) return TRUE;
    DWORD attributes = GetFileAttributesW(extensionPath);
    return attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static BOOL WriteRegistryPolicies(void)
{
    HKEY chromium = NULL, forceList = NULL, sources = NULL;
    WCHAR extensionUrl[128] = L"";
    DWORD enabled = 1;
    LSTATUS result;
    if (!AppendWide(extensionUrl, 128, g_extensionId) ||
        !AppendWide(extensionUrl, 128, L";https://update.doufen.org/")) return FALSE;

    result = RegCreateKeyExW(HKEY_CURRENT_USER, L"SOFTWARE\\Policies\\Chromium", 0,
        NULL, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &chromium, NULL);
    if (result != ERROR_SUCCESS) goto cleanup;
    result = RegCreateKeyExW(HKEY_CURRENT_USER,
        L"SOFTWARE\\Policies\\Chromium\\ExtensionInstallForcelist", 0,
        NULL, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &forceList, NULL);
    if (result != ERROR_SUCCESS) goto cleanup;
    result = RegCreateKeyExW(HKEY_CURRENT_USER,
        L"SOFTWARE\\Policies\\Chromium\\ExtensionInstallSources", 0,
        NULL, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &sources, NULL);
    if (result != ERROR_SUCCESS) goto cleanup;
    result = RegSetValueExW(chromium, L"ExtensionAllowInsecureUpdates", 0,
        REG_DWORD, (const BYTE *)&enabled, sizeof(enabled));
    if (result != ERROR_SUCCESS) goto cleanup;
    result = RegSetValueExW(forceList, L"1", 0, REG_SZ, (const BYTE *)extensionUrl,
        (DWORD)((wcslen(extensionUrl) + 1) * sizeof(WCHAR)));
    if (result != ERROR_SUCCESS) goto cleanup;
    result = RegSetValueExW(sources, L"1", 0, REG_SZ, (const BYTE *)EXTENSION_SOURCE,
        (DWORD)sizeof(EXTENSION_SOURCE));
cleanup:
    if (sources) RegCloseKey(sources);
    if (forceList) RegCloseKey(forceList);
    if (chromium) RegCloseKey(chromium);
    if (result != ERROR_SUCCESS) SetLastError((DWORD)result);
    return result == ERROR_SUCCESS;
}

static BOOL StartupChromium(void)
{
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    WCHAR commandLine[COMMAND_CAPACITY] = L"\"";
    startup.cb = sizeof(startup);
    if (!AppendWide(commandLine, COMMAND_CAPACITY, g_chromePath) ||
        !AppendWide(commandLine, COMMAND_CAPACITY, L"\" --user-data-dir=\"") ||
        !AppendWide(commandLine, COMMAND_CAPACITY, g_userDataPath) ||
        !AppendWide(commandLine, COMMAND_CAPACITY, L"\"")) return FALSE;

    SetEnvironmentVariableW(L"GOOGLE_API_KEY", L"no");
    SetEnvironmentVariableW(L"GOOGLE_DEFAULT_CLIENT_ID", L"no");
    SetEnvironmentVariableW(L"GOOGLE_DEFAULT_CLIENT_SECRET", L"no");
    // CreateProcessW can modify commandLine. Both paths are absolute and quoted,
    // so launching through a shortcut with another working directory is safe.
    if (!CreateProcessW(g_chromePath, commandLine, NULL, NULL, FALSE, 0, NULL,
                       g_directory, &startup, &process)) return FALSE;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return TRUE;
}

static BOOL RunAsAdministrator(void)
{
    SHELLEXECUTEINFOW info = {0};
    info.cbSize = sizeof(info);
    info.lpVerb = L"runas";
    info.lpFile = g_executable;
    info.lpDirectory = g_directory;
    info.nShow = SW_SHOWNORMAL;
    return ShellExecuteExW(&info);
}

static void ShowError(HWND window, const WCHAR *operation)
{
    DWORD error = GetLastError();
    WCHAR detail[1024] = L"", message[1400] = L"";
    FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, error, 0, detail, 1024, NULL);
    swprintf(message, 1400, L"%ls失败（错误 %lu）。\n%ls", operation, (unsigned long)error, detail);
    MessageBoxW(window, message, L"豆伴启动器", MB_OK | MB_ICONERROR);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR arguments, int show)
{
    (void)instance; (void)previous; (void)arguments; (void)show;
    HWND window = GetForegroundWindow();
    if (!InitializePaths()) { ShowError(window, L"读取启动器路径"); return 1; }
    if (!LoadSettings()) { ShowError(window, L"读取 config.ini 的 [extension] id（应为 32 位 a-p 字母）"); return 1; }
    if (IsFirstRun() && !WriteRegistryPolicies()) {
        DWORD error = GetLastError();
        if (error == ERROR_ACCESS_DENIED && MessageBoxW(window,
            L"没有写入 Chromium 策略的权限。是否以管理员身份重新运行？",
            L"豆伴启动器", MB_YESNO | MB_ICONQUESTION) == IDYES) {
            if (!RunAsAdministrator()) { ShowError(window, L"以管理员身份启动"); return 1; }
            return 0;
        }
        SetLastError(error);
        ShowError(window, L"写入 Chromium 策略");
        return 1;
    }
    if (!StartupChromium()) { ShowError(window, L"启动 chrome\\chrome.exe"); return 1; }
    return 0;
}
