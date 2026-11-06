cmake_minimum_required(VERSION 3.16)
project(ChromeLauncher LANGUAGES C)

if(NOT WIN32)
    message(FATAL_ERROR "ChromeLauncher requires Windows or a Windows cross-compilation toolchain")
endif()
enable_language(RC)

add_executable(ChromeLauncher WIN32 main.c main.rc)
target_include_directories(ChromeLauncher PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_features(ChromeLauncher PRIVATE c_std_11)
target_compile_definitions(ChromeLauncher PRIVATE UNICODE _UNICODE)
target_link_libraries(ChromeLauncher PRIVATE advapi32 shell32 user32)
set_target_properties(ChromeLauncher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
)
if(MSVC)
    target_compile_options(ChromeLauncher PRIVATE
        "$<$<COMPILE_LANGUAGE:C>:/W4>" "$<$<COMPILE_LANGUAGE:C>:/utf-8>")
else()
    target_compile_options(ChromeLauncher PRIVATE
        "$<$<COMPILE_LANGUAGE:C>:-Wall>" "$<$<COMPILE_LANGUAGE:C>:-Wextra>")
endif()
configure_file(config.ini.example config.ini COPYONLY)
