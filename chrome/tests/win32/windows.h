#ifndef TOFU_TEST_WINDOWS_H
#define TOFU_TEST_WINDOWS_H
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
typedef int BOOL;
typedef uint32_t DWORD;
typedef int32_t LSTATUS;
typedef unsigned char BYTE;
typedef wchar_t WCHAR;
typedef char *LPSTR;
typedef void *HANDLE;
typedef HANDLE HWND;
typedef HANDLE HINSTANCE;
typedef HANDLE HKEY;
#define WINAPI
#define TRUE 1
#define FALSE 0
#define ERROR_SUCCESS 0
#define ERROR_ACCESS_DENIED 5
#define ERROR_INVALID_DATA 13
#define ERROR_BAD_PATHNAME 161
#define ERROR_INSUFFICIENT_BUFFER 122
#define INVALID_FILE_ATTRIBUTES ((DWORD)-1)
#define FILE_ATTRIBUTE_DIRECTORY 16
#define HKEY_CURRENT_USER ((HKEY)(uintptr_t)1)
#define REG_OPTION_NON_VOLATILE 0
#define KEY_SET_VALUE 2
#define REG_DWORD 4
#define REG_SZ 1
#define SW_SHOWNORMAL 1
#define FORMAT_MESSAGE_FROM_SYSTEM 0x1000
#define FORMAT_MESSAGE_IGNORE_INSERTS 0x200
#define MB_OK 0
#define MB_ICONERROR 16
#define MB_YESNO 4
#define MB_ICONQUESTION 32
#define IDYES 6
typedef struct { DWORD cb; } STARTUPINFOW;
typedef struct { HANDLE hProcess, hThread; } PROCESS_INFORMATION;
void SetLastError(DWORD);
DWORD GetLastError(void);
DWORD GetModuleFileNameW(HANDLE,WCHAR*,DWORD);
DWORD GetPrivateProfileStringW(const WCHAR*,const WCHAR*,const WCHAR*,WCHAR*,DWORD,const WCHAR*);
DWORD GetFileAttributesW(const WCHAR*);
LSTATUS RegCreateKeyExW(HKEY,const WCHAR*,DWORD,WCHAR*,DWORD,DWORD,void*,HKEY*,DWORD*);
LSTATUS RegSetValueExW(HKEY,const WCHAR*,DWORD,DWORD,const BYTE*,DWORD);
LSTATUS RegCloseKey(HKEY);
BOOL SetEnvironmentVariableW(const WCHAR*,const WCHAR*);
BOOL CreateProcessW(const WCHAR*,WCHAR*,void*,void*,BOOL,DWORD,void*,const WCHAR*,STARTUPINFOW*,PROCESS_INFORMATION*);
BOOL CloseHandle(HANDLE);
DWORD FormatMessageW(DWORD,void*,DWORD,DWORD,WCHAR*,DWORD,void*);
int MessageBoxW(HWND,const WCHAR*,const WCHAR*,unsigned int);
HWND GetForegroundWindow(void);
#endif
