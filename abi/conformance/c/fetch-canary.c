#include "yurt_abi.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FETCH_RESP_INITIAL_CAP 65536

static int span_is_valid(uint32_t offset, uint32_t length, uint32_t size) {
  return offset <= size && length <= size - offset;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: fetch-canary URL\n");
    return 2;
  }

  const char *method = "GET";
  size_t url_len = strlen(argv[1]);
  size_t method_len = strlen(method);
  size_t req_len = sizeof(yurt_fetch_request_v1) + url_len + method_len;
  uint8_t *req = calloc(1, req_len);
  if (!req) return 1;
  yurt_fetch_request_v1 *header = (yurt_fetch_request_v1 *)req;
  header->size = (uint32_t)req_len;
  header->version = YURT_ABI_RECORD_VERSION_1;
  header->url_offset = sizeof(yurt_fetch_request_v1);
  header->url_length = (uint32_t)url_len;
  header->method_offset = (uint32_t)(sizeof(yurt_fetch_request_v1) + url_len);
  header->method_length = (uint32_t)method_len;
  header->headers_offset = (uint32_t)req_len;
  header->headers_count = 0;
  header->body_offset = (uint32_t)req_len;
  header->body_length = 0;
  header->redirect_mode = YURT_FETCH_REDIRECT_MANUAL;
  memcpy(req + header->url_offset, argv[1], url_len);
  memcpy(req + header->method_offset, method, method_len);

  int cap = FETCH_RESP_INITIAL_CAP;
  uint8_t *resp = malloc((size_t)cap);
  if (!resp) {
    free(req);
    return 1;
  }
  int written = yurt_host_network_fetch((int)(uintptr_t)req, (int)req_len, (int)(uintptr_t)resp, cap);
  if (written > cap) {
    cap = written;
    uint8_t *retry = realloc(resp, (size_t)cap);
    if (!retry) {
      free(req);
      free(resp);
      return 1;
    }
    resp = retry;
    written = yurt_host_network_fetch((int)(uintptr_t)req, (int)req_len, (int)(uintptr_t)resp, cap);
  }
  free(req);
  if (written < (int)sizeof(yurt_fetch_response_v1)) {
    fprintf(stderr, "fetch failed: %d\n", written);
    free(resp);
    return 1;
  }

  yurt_fetch_response_v1 *response = (yurt_fetch_response_v1 *)resp;
  if (response->version != YURT_ABI_RECORD_VERSION_1 ||
      response->size != (uint32_t)written ||
      response->status >= 400 ||
      response->error_length != 0 ||
      !span_is_valid(response->body_offset, response->body_length, response->size)) {
    fprintf(stderr, "fetch response invalid\n");
    free(resp);
    return 1;
  }

  fwrite(resp + response->body_offset, 1, response->body_length, stdout);
  free(resp);
  return 0;
}
