#pragma once
#include <cstddef>
using nvs_handle_t = int;
constexpr int ESP_OK = 0, NVS_READONLY = 0, NVS_READWRITE = 1;
int nvs_open(const char*, int, nvs_handle_t*);
int nvs_get_str(nvs_handle_t, const char*, char*, size_t*);
int nvs_set_str(nvs_handle_t, const char*, const char*);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
