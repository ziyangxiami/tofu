// Executes the real launcher functions against inert Win32 API test doubles.
#include <assert.h>
#include <stdio.h>
#include "../main.c"

static const WCHAR *modulePath = L"C:\\测试 Folder\\ChromeLauncher.exe";
static const WCHAR *configuredId = NULL;
static DWORD lastError;
static BOOL processResult = TRUE, truncateModule = FALSE;
static int closedHandles, registryCalls, registryFailureAt, registryClosed, registryWrites;
static BOOL registryWriteFailure;
void SetLastError(DWORD error) { lastError = error; }
DWORD GetLastError(void) { return lastError; }
DWORD GetModuleFileNameW(HANDLE module, WCHAR *out, DWORD count) {
    (void)module;
    if (truncateModule) return count;
    assert(wcslen(modulePath) < count);
    wcscpy(out, modulePath);
    return (DWORD)wcslen(out);
}
DWORD GetPrivateProfileStringW(const WCHAR *section, const WCHAR *key, const WCHAR *fallback,
    WCHAR *out, DWORD count, const WCHAR *filename) {
    assert(wcscmp(section, L"extension") == 0);
    assert(wcscmp(key, L"id") == 0);
    assert(wcscmp(filename, L"C:\\测试 Folder\\config.ini") == 0);
    const WCHAR *value = configuredId ? configuredId : fallback;
    size_t length = wcslen(value);
    if (length >= count) length = count - 1;
    wmemcpy(out, value, length); out[length] = 0;
    return (DWORD)length;
}
DWORD GetFileAttributesW(const WCHAR *path) { (void)path; return INVALID_FILE_ATTRIBUTES; }
LSTATUS RegCreateKeyExW(HKEY root, const WCHAR *path, DWORD reserved, WCHAR *kind,
    DWORD options, DWORD rights, void *security, HKEY *out, DWORD *disposition) {
    (void)path; (void)reserved; (void)kind; (void)options; (void)security; (void)disposition;
    assert(root == HKEY_CURRENT_USER); assert(rights == KEY_SET_VALUE);
    ++registryCalls;
    if (registryCalls == registryFailureAt) return ERROR_ACCESS_DENIED;
    *out = (HKEY)(uintptr_t)(registryCalls + 10);
    return ERROR_SUCCESS;
}
LSTATUS RegSetValueExW(HKEY key, const WCHAR *name, DWORD reserved, DWORD type,
    const BYTE *value, DWORD size) {
    (void)key; (void)name; (void)reserved;
    ++registryWrites;
    if (registryWriteFailure) return ERROR_ACCESS_DENIED;
    if (type == REG_SZ) assert(size == (wcslen((const WCHAR *)value) + 1) * sizeof(WCHAR));
    return ERROR_SUCCESS;
}
LSTATUS RegCloseKey(HKEY key) { assert(key); registryClosed++; SetLastError(999); return ERROR_SUCCESS; }
BOOL SetEnvironmentVariableW(const WCHAR *key, const WCHAR *value) { (void)key; (void)value; return TRUE; }
BOOL CreateProcessW(const WCHAR *path, WCHAR *command, void *a, void *b, BOOL inherited,
    DWORD flags, void *environment, const WCHAR *workingDirectory, STARTUPINFOW *startup,
    PROCESS_INFORMATION *process) {
    (void)a; (void)b; (void)flags; (void)environment;
    assert(!inherited); assert(startup->cb == sizeof(*startup));
    assert(wcscmp(path, L"C:\\测试 Folder\\chrome\\chrome.exe") == 0);
    assert(wcscmp(workingDirectory, L"C:\\测试 Folder\\") == 0);
    assert(wcscmp(command, L"\"C:\\测试 Folder\\chrome\\chrome.exe\" --user-data-dir=\"C:\\测试 Folder\\userdata\"") == 0);
    command[0] = L'x'; // Proves the caller supplied writable memory.
    if (!processResult) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    process->hProcess = (HANDLE)(uintptr_t)2; process->hThread = (HANDLE)(uintptr_t)3;
    return TRUE;
}
BOOL CloseHandle(HANDLE handle) { assert(handle); closedHandles++; return TRUE; }
DWORD FormatMessageW(DWORD a, void *b, DWORD c, DWORD d, WCHAR *out, DWORD count, void *e) {
    (void)a; (void)b; (void)c; (void)d; (void)out; (void)count; (void)e; return 0;
}
int MessageBoxW(HWND a, const WCHAR *b, const WCHAR *c, unsigned int d) { (void)a; (void)b; (void)c; (void)d; return 0; }
HWND GetForegroundWindow(void) { return NULL; }
BOOL ShellExecuteExW(SHELLEXECUTEINFOW *info) {
    assert(info->cbSize == sizeof(*info));
    assert(wcscmp(info->lpFile, g_executable) == 0);
    assert(wcscmp(info->lpDirectory, g_directory) == 0);
    return TRUE;
}
int main(void) {
    assert(InitializePaths());
    assert(wcscmp(g_directory, L"C:\\测试 Folder\\") == 0);
    assert(LoadSettings()); assert(wcslen(g_extensionId) == 32);
    configuredId = L"short"; assert(!LoadSettings()); assert(lastError == ERROR_INVALID_DATA);
    configuredId = L"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"; assert(!LoadSettings());
    configuredId = L"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; assert(!LoadSettings());
    configuredId = L"abcdefghijklmnopabcdefghijklmnop"; assert(LoadSettings());
    assert(StartupChromium()); assert(closedHandles == 2);
    processResult = FALSE; assert(!StartupChromium()); assert(closedHandles == 2);
    assert(lastError == ERROR_ACCESS_DENIED);
    for (int fail = 1; fail <= 3; ++fail) {
        registryCalls = registryClosed = registryWrites = 0; registryFailureAt = fail;
        assert(!WriteRegistryPolicies()); assert(registryClosed == fail - 1);
        assert(lastError == ERROR_ACCESS_DENIED);
    }
    registryCalls = registryClosed = registryWrites = 0; registryFailureAt = 0;
    registryWriteFailure = TRUE; assert(!WriteRegistryPolicies()); assert(registryClosed == 3);
    assert(lastError == ERROR_ACCESS_DENIED);
    registryCalls = registryClosed = registryWrites = 0; registryWriteFailure = FALSE;
    assert(WriteRegistryPolicies()); assert(registryClosed == 3); assert(registryWrites == 3);
    assert(RunAsAdministrator());
    modulePath = L"C:\\ChromeLauncher.exe"; assert(InitializePaths()); assert(wcscmp(g_directory, L"C:\\") == 0);
    modulePath = L"invalid"; assert(!InitializePaths()); assert(lastError == ERROR_BAD_PATHNAME);
    truncateModule = TRUE; assert(!InitializePaths()); assert(lastError == ERROR_INSUFFICIENT_BUFFER);
    WCHAR tiny[3] = L"a"; assert(!AppendWide(tiny, 3, L"bc")); assert(wcscmp(tiny, L"a") == 0);
    puts("launcher regression: paths, configuration, writable command line and handle cleanup passed");
    return 0;
}
