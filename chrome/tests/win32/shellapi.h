#ifndef TOFU_TEST_SHELLAPI_H
#define TOFU_TEST_SHELLAPI_H
#include "windows.h"
typedef struct {
    DWORD cbSize;
    const WCHAR *lpVerb, *lpFile, *lpDirectory;
    int nShow;
} SHELLEXECUTEINFOW;
BOOL ShellExecuteExW(SHELLEXECUTEINFOW*);
#endif
