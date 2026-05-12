#include "yurt_abi.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define YURT_FETCH_RESP_INITIAL_CAP 65536
#define YURT_FETCH_REDIRECT_MANUAL 1u

typedef struct yurt_fetch_request_native_v1 {
  uint32_t size;
  uint16_t version;
  uint16_t flags;
  uint32_t url_offset;
  uint32_t url_length;
  uint32_t method_offset;
  uint32_t method_length;
  uint32_t headers_offset;
  uint32_t headers_count;
  uint32_t body_offset;
  uint32_t body_length;
  uint32_t redirect_mode;
} yurt_fetch_request_native_v1;

typedef struct yurt_fetch_response_native_v1 {
  uint32_t size;
  uint16_t version;
  uint16_t flags;
  uint32_t status;
  uint32_t headers_offset;
  uint32_t headers_count;
  uint32_t body_offset;
  uint32_t body_length;
  uint32_t error_offset;
  uint32_t error_length;
} yurt_fetch_response_native_v1;

static int span_is_valid(uint32_t offset, uint32_t length, uint32_t size) {
  return offset <= size && length <= size - offset;
}

static int build_fetch_request(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  uint8_t **out_req,
  size_t *out_len
) {
  const char *effective_method = method ? method : "GET";
  size_t header_size = sizeof(yurt_fetch_request_native_v1);
  size_t url_len = strlen(url);
  size_t method_len = strlen(effective_method);
  size_t body_len = body ? strlen(body) : 0;
  size_t size = header_size + url_len + method_len + body_len;
  yurt_fetch_request_native_v1 *req;
  uint8_t *bytes;
  size_t cursor;

  if (headers_json && strcmp(headers_json, "{}") != 0) {
    errno = ENOTSUP;
    return -1;
  }

  bytes = calloc(1, size);
  if (!bytes) {
    return -1;
  }

  req = (yurt_fetch_request_native_v1 *)bytes;
  req->size = (uint32_t)size;
  req->version = YURT_ABI_RECORD_VERSION_1;
  req->url_offset = (uint32_t)header_size;
  req->url_length = (uint32_t)url_len;
  req->method_offset = (uint32_t)(header_size + url_len);
  req->method_length = (uint32_t)method_len;
  req->headers_offset = sizeof(yurt_fetch_request_native_v1);
  req->headers_count = 0;
  req->body_offset = (uint32_t)(header_size + url_len + method_len);
  req->body_length = (uint32_t)body_len;
  req->redirect_mode = YURT_FETCH_REDIRECT_MANUAL;

  cursor = header_size;
  memcpy(bytes + cursor, url, url_len);
  cursor += url_len;
  memcpy(bytes + cursor, effective_method, method_len);
  cursor += method_len;
  if (body_len > 0) {
    memcpy(bytes + cursor, body, body_len);
  }

  *out_req = bytes;
  *out_len = size;
  return 0;
}

static char *dup_fetch_span(
  const uint8_t *record,
  uint32_t size,
  uint32_t offset,
  uint32_t length
) {
  char *out;
  if (!span_is_valid(offset, length, size)) {
    errno = EIO;
    return NULL;
  }
  out = malloc((size_t)length + 1);
  if (!out) return NULL;
  memcpy(out, record + offset, length);
  out[length] = '\0';
  return out;
}

int yurt_fetch_text(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  char **out_body
) {
  uint8_t *req = NULL;
  size_t req_len = 0;
  char *resp;
  int cap = YURT_FETCH_RESP_INITIAL_CAP;
  int written;
  yurt_fetch_response_native_v1 *header;
  char *text;

  if (!url || !out_body) {
    errno = EINVAL;
    return -1;
  }
  *out_body = NULL;

  if (build_fetch_request(url, method, headers_json, body, &req, &req_len) != 0) {
    return -1;
  }

  resp = malloc((size_t)cap + 1);
  if (!resp) {
    free(req);
    return -1;
  }

  written = yurt_host_network_fetch((int)(uintptr_t)req, (int)req_len, (int)(uintptr_t)resp, cap);
  if (written > cap) {
    cap = written;
    char *retry = realloc(resp, (size_t)cap + 1);
    if (!retry) {
      free(req);
      free(resp);
      return -1;
    }
    resp = retry;
    written = yurt_host_network_fetch((int)(uintptr_t)req, (int)req_len, (int)(uintptr_t)resp, cap);
  }
  free(req);
  if (written < 0) {
    free(resp);
    return -1;
  }
  if (written < (int)sizeof(yurt_fetch_response_native_v1)) {
    free(resp);
    errno = EIO;
    return -1;
  }

  header = (yurt_fetch_response_native_v1 *)resp;
  if (header->version != YURT_ABI_RECORD_VERSION_1 ||
      header->size != (uint32_t)written ||
      header->size < sizeof(yurt_fetch_response_native_v1)) {
    free(resp);
    errno = EIO;
    return -1;
  }

  if (header->error_length > 0) {
    free(resp);
    errno = EIO;
    return -1;
  }

  text = dup_fetch_span(
    (const uint8_t *)resp,
    header->size,
    header->body_offset,
    header->body_length
  );
  free(resp);
  if (!text) {
    return -1;
  }
  *out_body = text;
  return 0;
}
