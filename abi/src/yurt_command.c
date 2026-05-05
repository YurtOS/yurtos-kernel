#include "yurt_abi.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define YURT_REQ_CAP 1024
#define YURT_RESP_INITIAL_CAP 4096

struct yurt_stream_entry {
  FILE *stream;
  char path[64];
  int exit_code;
  struct yurt_stream_entry *next;
};

static struct yurt_stream_entry *yurt_streams = NULL;
static unsigned int yurt_stream_counter = 0;

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

static int json_write_string(char *dst, size_t cap, const char *value) {
  size_t used = 0;
  if (cap < 3) {
    return -1;
  }

  dst[used++] = '"';
  for (const unsigned char *p = (const unsigned char *)value; *p != '\0'; ++p) {
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
      size_t escape_len = strlen(escape);
      if (used + escape_len + 1 >= cap) {
        return -1;
      }
      memcpy(dst + used, escape, escape_len);
      used += escape_len;
      continue;
    }

    if (*p < 0x20) {
      return -1;
    }
    if (used + 2 >= cap) {
      return -1;
    }
    dst[used++] = (char)*p;
  }

  dst[used++] = '"';
  dst[used] = '\0';
  return 0;
}

static int build_run_command_request(const char *cmd, char *dst, size_t cap) {
  char quoted_cmd[YURT_REQ_CAP];
  if (json_write_string(quoted_cmd, sizeof(quoted_cmd), cmd) != 0) {
    errno = EOVERFLOW;
    return -1;
  }

  int written = snprintf(dst, cap, "{\"cmd\":%s}", quoted_cmd);
  if (written < 0 || (size_t)written >= cap) {
    errno = EOVERFLOW;
    return -1;
  }
  return written;
}

static int parse_exit_code(const char *json, size_t json_len, int *exit_code) {
  const char *field = find_json_field(json, json_len, "exit_code");
  char *end = NULL;
  long value;

  if (!field) {
    errno = EIO;
    return -1;
  }

  value = strtol(field, &end, 10);
  if (end == field) {
    errno = EIO;
    return -1;
  }

  *exit_code = (int)value;
  return 0;
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

static int parse_json_string_field(
  const char *json,
  size_t json_len,
  const char *field_name,
  char *dst,
  size_t cap
) {
  const char *field = find_json_field(json, json_len, field_name);
  const char *end = json + json_len;
  size_t used = 0;

  if (!field || cap == 0) {
    errno = EIO;
    return -1;
  }

  if (field >= end || *field != '"') {
    errno = EIO;
    return -1;
  }
  field += 1;

  while (field < end) {
    char ch = *field++;
    if (ch == '"') {
      dst[used] = '\0';
      return 0;
    }
    if (ch == '\\') {
      if (field >= end) {
        errno = EIO;
        return -1;
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
              errno = EIO;
              return -1;
            }
            digit = hex_digit_value(*field++);
            if (digit < 0) {
              errno = EIO;
              return -1;
            }
            codepoint = (codepoint << 4) | digit;
          }

          if (codepoint > 0x7f) {
            errno = ENOTSUP;
            return -1;
          }
          ch = (char)codepoint;
          break;
        }
        default:
          errno = EIO;
          return -1;
      }
    }
    if (used + 1 >= cap) {
      errno = EOVERFLOW;
      return -1;
    }
    dst[used++] = ch;
  }

  errno = EIO;
  return -1;
}

int yurt_json_call(const char *json, char **out, size_t *out_len) {
  char *buffer;
  size_t cap = YURT_RESP_INITIAL_CAP;

  if (!json || !out || !out_len) {
    errno = EINVAL;
    return -1;
  }

  buffer = malloc(cap + 1);
  if (!buffer) {
    errno = ENOMEM;
    return -1;
  }

  for (;;) {
    int rc = yurt_host_run_command(
      (int)(intptr_t)json,
      (int)strlen(json),
      (int)(intptr_t)buffer,
      (int)cap
    );

    if (rc < 0) {
      free(buffer);
      errno = EIO;
      return -1;
    }

    if ((size_t)rc <= cap) {
      buffer[rc] = '\0';
      *out = buffer;
      *out_len = (size_t)rc;
      return 0;
    }

    cap = (size_t)rc;
    char *grown = realloc(buffer, cap + 1);
    if (!grown) {
      free(buffer);
      errno = ENOMEM;
      return -1;
    }
    buffer = grown;
  }
}

static struct yurt_stream_entry *open_capture_stream(int exit_code) {
  struct yurt_stream_entry *entry = malloc(sizeof(*entry));
  FILE *stream = NULL;
  if (!entry) {
    errno = ENOMEM;
    return NULL;
  }

  for (unsigned int attempt = 0; attempt < 128; ++attempt) {
    unsigned int id = yurt_stream_counter++;
    int written = snprintf(
      entry->path,
      sizeof(entry->path),
      "/tmp/yurt-popen-%08x-%02x.txt",
      id,
      attempt
    );
    if (written < 0 || (size_t)written >= sizeof(entry->path)) {
      free(entry);
      errno = EOVERFLOW;
      return NULL;
    }

    stream = fopen(entry->path, "wx+");
    if (stream) {
      entry->stream = stream;
      entry->exit_code = exit_code;
      entry->next = yurt_streams;
      yurt_streams = entry;
      return entry;
    }

    if (errno != EEXIST) {
      free(entry);
      return NULL;
    }
  }

  free(entry);
  errno = EEXIST;
  return NULL;
}

static struct yurt_stream_entry *detach_capture_stream(FILE *stream) {
  struct yurt_stream_entry **cursor = &yurt_streams;
  while (*cursor) {
    struct yurt_stream_entry *entry = *cursor;
    if (entry->stream == stream) {
      *cursor = entry->next;
      return entry;
    }
    cursor = &entry->next;
  }
  return NULL;
}

static void destroy_capture_stream(struct yurt_stream_entry *entry, int close_stream) {
  if (!entry) {
    return;
  }
  if (close_stream && entry->stream) {
    fclose(entry->stream);
  }
  remove(entry->path);
  free(entry);
}

int yurt_system(const char *cmd) {
  char req[YURT_REQ_CAP];
  char *resp = NULL;
  size_t resp_len = 0;
  int written;
  int exit_code;

  if (!cmd) {
    errno = EINVAL;
    return -1;
  }

  written = build_run_command_request(cmd, req, sizeof(req));
  if (written < 0) {
    return -1;
  }

  if (yurt_json_call(req, &resp, &resp_len) < 0) {
    return -1;
  }

  if (parse_exit_code(resp, resp_len, &exit_code) != 0) {
    free(resp);
    return -1;
  }

  free(resp);
  return exit_code;
}

FILE *yurt_popen(const char *cmd, const char *mode) {
  char req[YURT_REQ_CAP];
  char *resp = NULL;
  size_t resp_len = 0;
  char *stdout_buf = NULL;
  struct yurt_stream_entry *entry = NULL;
  int written;
  int exit_code;

  if (!cmd || !mode) {
    errno = EINVAL;
    return NULL;
  }
  if (strcmp(mode, "r") != 0) {
    errno = ENOTSUP;
    return NULL;
  }

  written = build_run_command_request(cmd, req, sizeof(req));
  if (written < 0) {
    return NULL;
  }

  if (yurt_json_call(req, &resp, &resp_len) < 0) {
    return NULL;
  }

  stdout_buf = malloc(resp_len + 1);
  if (!stdout_buf) {
    free(resp);
    errno = ENOMEM;
    return NULL;
  }

  if (parse_exit_code(resp, resp_len, &exit_code) != 0) {
    free(stdout_buf);
    free(resp);
    return NULL;
  }

  if (parse_json_string_field(resp, resp_len, "stdout", stdout_buf, resp_len + 1) != 0) {
    free(stdout_buf);
    free(resp);
    return NULL;
  }

  free(resp);

  entry = open_capture_stream(exit_code);
  if (!entry) {
    free(stdout_buf);
    return NULL;
  }

  if (fputs(stdout_buf, entry->stream) == EOF) {
    free(stdout_buf);
    destroy_capture_stream(detach_capture_stream(entry->stream), 1);
    return NULL;
  }

  free(stdout_buf);

  rewind(entry->stream);
  return entry->stream;
}

int yurt_pclose(FILE *stream) {
  struct yurt_stream_entry *entry;
  int rc;

  if (!stream) {
    errno = EINVAL;
    return -1;
  }

  entry = detach_capture_stream(stream);
  if (!entry) {
    errno = EINVAL;
    return -1;
  }

  rc = fclose(entry->stream);
  if (remove(entry->path) != 0 && rc == 0) {
    rc = -1;
  }

  if (rc != 0) {
    free(entry);
    return -1;
  }

  rc = entry->exit_code;
  free(entry);
  return rc;
}
