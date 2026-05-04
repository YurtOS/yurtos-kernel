#include "yurt_compat.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define YURT_FETCH_REQ_CAP 8192
#define YURT_FETCH_RESP_INITIAL_CAP 65536

static int append_raw(char *dst, size_t cap, size_t *used, const char *value) {
  size_t len = strlen(value);
  if (*used + len >= cap) {
    errno = EOVERFLOW;
    return -1;
  }
  memcpy(dst + *used, value, len);
  *used += len;
  dst[*used] = '\0';
  return 0;
}

static int append_json_string(char *dst, size_t cap, size_t *used, const char *value) {
  if (append_raw(dst, cap, used, "\"") != 0) {
    return -1;
  }

  for (const unsigned char *p = (const unsigned char *)(value ? value : ""); *p != '\0'; ++p) {
    const char *escape = NULL;
    switch (*p) {
      case '\\':
        escape = "\\\\";
        break;
      case '"':
        escape = "\\\"";
        break;
      case '\n':
        escape = "\\n";
        break;
      case '\r':
        escape = "\\r";
        break;
      case '\t':
        escape = "\\t";
        break;
      default:
        break;
    }

    if (escape) {
      if (append_raw(dst, cap, used, escape) != 0) {
        return -1;
      }
      continue;
    }
    if (*p < 0x20) {
      errno = EINVAL;
      return -1;
    }
    if (*used + 1 >= cap) {
      errno = EOVERFLOW;
      return -1;
    }
    dst[(*used)++] = (char)*p;
    dst[*used] = '\0';
  }

  return append_raw(dst, cap, used, "\"");
}

static const char *find_json_field(const char *json, size_t json_len, const char *field) {
  char needle[64];
  int written = snprintf(needle, sizeof(needle), "\"%s\":", field);
  size_t needle_len;

  if (written <= 0 || (size_t)written >= sizeof(needle)) {
    return NULL;
  }
  needle_len = (size_t)written;
  if (needle_len > json_len) {
    return NULL;
  }

  for (size_t offset = 0; offset + needle_len <= json_len; ++offset) {
    if (memcmp(json + offset, needle, needle_len) == 0) {
      return json + offset + needle_len;
    }
  }
  return NULL;
}

static int hex_digit_value(char ch) {
  if (ch >= '0' && ch <= '9') {
    return ch - '0';
  }
  if (ch >= 'a' && ch <= 'f') {
    return 10 + (ch - 'a');
  }
  if (ch >= 'A' && ch <= 'F') {
    return 10 + (ch - 'A');
  }
  return -1;
}

static char *dup_json_string_field(const char *json, size_t json_len, const char *field_name) {
  const char *field = find_json_field(json, json_len, field_name);
  const char *end = json + json_len;
  char *out;
  size_t used = 0;

  if (!field) {
    return NULL;
  }
  while (field < end && (*field == ' ' || *field == '\n' || *field == '\r' || *field == '\t')) {
    field++;
  }
  if ((size_t)(end - field) >= 4 && memcmp(field, "null", 4) == 0) {
    return NULL;
  }
  if (field >= end || *field != '"') {
    errno = EIO;
    return NULL;
  }
  field++;

  out = malloc((size_t)(end - field) + 1);
  if (!out) {
    return NULL;
  }

  while (field < end) {
    char ch = *field++;
    if (ch == '"') {
      out[used] = '\0';
      return out;
    }
    if (ch == '\\') {
      if (field >= end) {
        free(out);
        errno = EIO;
        return NULL;
      }
      ch = *field++;
      switch (ch) {
        case '"':
        case '\\':
        case '/':
          break;
        case 'n':
          ch = '\n';
          break;
        case 'r':
          ch = '\r';
          break;
        case 't':
          ch = '\t';
          break;
        case 'b':
          ch = '\b';
          break;
        case 'f':
          ch = '\f';
          break;
        case 'u': {
          int codepoint = 0;
          for (int i = 0; i < 4; ++i) {
            int digit;
            if (field >= end) {
              free(out);
              errno = EIO;
              return NULL;
            }
            digit = hex_digit_value(*field++);
            if (digit < 0) {
              free(out);
              errno = EIO;
              return NULL;
            }
            codepoint = (codepoint << 4) | digit;
          }
          if (codepoint > 0x7f) {
            free(out);
            errno = ENOTSUP;
            return NULL;
          }
          ch = (char)codepoint;
          break;
        }
        default:
          free(out);
          errno = EIO;
          return NULL;
      }
    }
    out[used++] = ch;
  }

  free(out);
  errno = EIO;
  return NULL;
}

static int build_fetch_request(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  char *dst,
  size_t cap
) {
  size_t used = 0;
  dst[0] = '\0';

  if (append_raw(dst, cap, &used, "{\"url\":") != 0 ||
      append_json_string(dst, cap, &used, url) != 0 ||
      append_raw(dst, cap, &used, ",\"method\":") != 0 ||
      append_json_string(dst, cap, &used, method ? method : "GET") != 0 ||
      append_raw(dst, cap, &used, ",\"headers\":") != 0 ||
      append_raw(dst, cap, &used, headers_json ? headers_json : "{}") != 0 ||
      append_raw(dst, cap, &used, ",\"body\":") != 0) {
    return -1;
  }
  if (body) {
    if (append_json_string(dst, cap, &used, body) != 0) {
      return -1;
    }
  } else if (append_raw(dst, cap, &used, "null") != 0) {
    return -1;
  }
  return append_raw(dst, cap, &used, ",\"redirect\":\"manual\"}");
}

int yurt_fetch_text(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  char **out_body
) {
  char req[YURT_FETCH_REQ_CAP];
  char *resp;
  int cap = YURT_FETCH_RESP_INITIAL_CAP;
  int written;
  char *error;
  char *text;

  if (!url || !out_body) {
    errno = EINVAL;
    return -1;
  }
  *out_body = NULL;

  if (build_fetch_request(url, method, headers_json, body, req, sizeof(req)) != 0) {
    return -1;
  }

  resp = malloc((size_t)cap + 1);
  if (!resp) {
    return -1;
  }

  written = yurt_host_network_fetch((int)(uintptr_t)req, (int)strlen(req), (int)(uintptr_t)resp, cap);
  if (written > cap) {
    cap = written;
    char *retry = realloc(resp, (size_t)cap + 1);
    if (!retry) {
      free(resp);
      return -1;
    }
    resp = retry;
    written = yurt_host_network_fetch((int)(uintptr_t)req, (int)strlen(req), (int)(uintptr_t)resp, cap);
  }
  if (written < 0) {
    free(resp);
    return -1;
  }
  resp[written] = '\0';

  error = dup_json_string_field(resp, (size_t)written, "error");
  if (error && error[0] != '\0') {
    free(error);
    free(resp);
    errno = EIO;
    return -1;
  }
  free(error);

  text = dup_json_string_field(resp, (size_t)written, "body");
  if (!text) {
    text = strdup("");
  }

  free(resp);
  if (!text) {
    return -1;
  }
  *out_body = text;
  return 0;
}
