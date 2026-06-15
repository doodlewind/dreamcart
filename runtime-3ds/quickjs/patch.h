#pragma once

#include <inttypes.h>
#include <stdarg.h>

int printf(const char *format, ...);

int sprintf(char *str, const char *format, ...);

int snprintf(char *str, size_t size, const char *format, ...);

int vsnprintf(char *str, size_t size, const char *format, va_list ap);

#define putchar(str) (0)

void debug_log(const char *str, int a);
