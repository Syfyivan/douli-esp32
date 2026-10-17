#include <cJSON.h>
#include <cassert>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>
#include "nvs.h"
// Exercise the actual firmware state machine with a power-loss-capable NVS fake.
#define private public
#include "backend_selection.h"
#undef private

std::string durable, pending;
bool fail_write = false, fail_commit = false;
int nvs_open(const char*, int, nvs_handle_t* h) { *h = 1; return 0; }
int nvs_get_str(nvs_handle_t, const char*, char* out, size_t* size) {
    if (durable.empty()) return -1;
    if (!out) { *size = durable.size() + 1; return 0; }
    if (*size < durable.size() + 1) return -1;
    std::memcpy(out, durable.c_str(), durable.size() + 1); return 0;
}
int nvs_set_str(nvs_handle_t, const char*, const char* text) {
    if (fail_write) return -1;
    pending = text; return 0;
}
int nvs_commit(nvs_handle_t) {
    if (fail_commit) return -1;
    durable = pending; return 0;
}
void nvs_close(nvs_handle_t) { pending.clear(); }

const std::string pc = "11111111-1111-1111-1111-111111111111";
const std::string phone = "22222222-2222-2222-2222-222222222222";
const std::string first = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const std::string second = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
cJSON* plan(const std::string& mode, const std::string& rev = first) {
    auto root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "v", 1);
    cJSON_AddStringToObject(root, "mode", mode.c_str());
    cJSON_AddStringToObject(root, "revision", rev.c_str());
    auto targets = cJSON_AddArrayToObject(root, "targets");
    // Deliberately put phone first: auto must still prefer the computer.
    for (const auto& kind : {std::string("phone"), std::string("computer")}) {
        if (mode != "auto" && mode != kind) continue;
        auto target = cJSON_CreateObject();
        cJSON_AddStringToObject(target, "id", (kind == "phone" ? phone : pc).c_str());
        cJSON_AddStringToObject(target, "kind", kind.c_str());
        cJSON_AddStringToObject(target, "url", kind == "phone" ?
            "ws://douli-node-22222222.local:8789/xiaozhi/v1/" : "wss://example.test:8443/xiaozhi/v1/");
        cJSON_AddStringToObject(target, "token", std::string(64, 'c').c_str());
        if (kind == "phone") cJSON_AddStringToObject(target, "fallbackUrl", "ws://192.168.0.105:8789/xiaozhi/v1/");
        cJSON_AddNumberToObject(target, "version", 1);
        cJSON_AddItemToArray(targets, target);
    }
    return root;
}
bool stage(BackendSelection& state, const std::string& mode, const std::string& rev = first) {
    auto json = plan(mode, rev); const bool result = state.Stage(json); cJSON_Delete(json); return result;
}
std::string report(BackendSelection& state, const char* field) {
    auto json = state.Status();
    std::string result = cJSON_GetObjectItemCaseSensitive(json, field)->valuestring;
    char* serialized = cJSON_PrintUnformatted(json);
    assert(std::string(serialized).find(std::string(64, 'c')) == std::string::npos);
    assert(std::string(serialized).find("ws://") == std::string::npos);
    cJSON_free(serialized); cJSON_Delete(json); return result;
}
int main() {
    BackendSelection state;
    assert(!state.HasPlan()); assert(state.BeginAttempt().id.empty());
    assert(stage(state, "computer")); assert(!stage(state, "phone"));
    assert(state.BeginAttempt().id == pc); assert(state.Connected());
    const auto saved_pc = durable;
    assert(report(state, "phase") == "applied");
    assert(stage(state, "phone", second)); assert(state.BeginAttempt().id == phone);
    state.Failed();
    assert(state.BeginAttempt().id == pc); assert(report(state, "failedRevision") == second);
    assert(report(state, "revision") == first);
    assert(stage(state, "phone", second));
    BackendSelection reboot_during_trial;
    assert(reboot_during_trial.BeginAttempt().id == pc);
    assert(report(reboot_during_trial, "failedRevision") == second);
    assert(stage(reboot_during_trial, "phone", second));
    assert(reboot_during_trial.BeginAttempt().id == phone); assert(reboot_during_trial.Connected());
    BackendSelection reboot_committed;
    assert(reboot_committed.BeginAttempt().fallback_url == "ws://192.168.0.105:8789/xiaozhi/v1/");
    for (int i = 0; i < 5; ++i) { assert(reboot_committed.BeginAttempt().id == phone); reboot_committed.Failed(); }
    assert(stage(reboot_committed, "auto"));
    assert(reboot_committed.BeginAttempt().id == pc); reboot_committed.Failed();
    assert(reboot_committed.BeginAttempt().id == phone); assert(reboot_committed.Connected());
    assert(reboot_committed.BeginAttempt().id == pc); reboot_committed.Failed();
    assert(reboot_committed.BeginAttempt().id == phone); reboot_committed.Failed();
    assert(reboot_committed.BeginAttempt().id == pc);
    BackendSelection auto_boot;
    assert(auto_boot.BeginAttempt().id == pc); auto_boot.Failed(); assert(auto_boot.BeginAttempt().id == phone);
    durable = saved_pc;
    BackendSelection failure;
    fail_write = true; assert(!stage(failure, "phone", second)); fail_write = false;
    assert(failure.BeginAttempt().id == pc);
    fail_commit = true; assert(!stage(failure, "phone", second)); fail_commit = false;
    assert(durable == saved_pc);
    assert(stage(failure, "phone", second)); assert(failure.BeginAttempt().id == phone);
    fail_commit = true; assert(!failure.Connected()); fail_commit = false; failure.Failed();
    assert(failure.BeginAttempt().id == pc);
    for (auto url : {"ws://public.test/xiaozhi/v1/", "ws://999.168.0.1/xiaozhi/v1/",
                    "wss://user@host/xiaozhi/v1/", "wss://host:65536/xiaozhi/v1/", "wss://host/wrong"}) {
        auto json = plan("phone"); auto target = cJSON_GetArrayItem(cJSON_GetObjectItem(json, "targets"), 0);
        cJSON_ReplaceItemInObject(target, "url", cJSON_CreateString(url));
        assert(!failure.Stage(json)); cJSON_Delete(json);
    }
    auto duplicate = plan("auto"); auto targets = cJSON_GetObjectItem(duplicate, "targets");
    cJSON_ReplaceItemInObject(cJSON_GetArrayItem(targets, 1), "id", cJSON_CreateString(phone.c_str()));
    assert(!failure.Stage(duplicate)); cJSON_Delete(duplicate);
    for (auto url : {"ws://public.test:8789/xiaozhi/v1/", "ws://192.168.0.105:80/xiaozhi/v1/"}) {
        auto json = plan("phone"); auto target = cJSON_GetArrayItem(cJSON_GetObjectItem(json, "targets"), 0);
        cJSON_ReplaceItemInObject(target, "fallbackUrl", cJSON_CreateString(url));
        assert(!failure.Stage(json)); cJSON_Delete(json);
    }
    auto remote_plan = plan("phone", second);
    auto remote_target = cJSON_GetArrayItem(cJSON_GetObjectItem(remote_plan, "targets"), 0);
    cJSON_AddStringToObject(remote_target, "remoteUrl", "wss://voice.test:8443/xiaozhi/v1/");
    assert(failure.Stage(remote_plan));
    assert(failure.BeginAttempt().remote_url == "wss://voice.test:8443/xiaozhi/v1/");
    assert(failure.Connected());
    BackendSelection remote_reboot;
    assert(remote_reboot.BeginAttempt().remote_url == "wss://voice.test:8443/xiaozhi/v1/");
    for (auto url : {"ws://public.test/xiaozhi/v1/", "ws://192.168.0.1/xiaozhi/v1/",
                     "wss://u:p@voice.test/xiaozhi/v1/", "wss://voice.test/wrong", ""}) {
        cJSON_ReplaceItemInObject(remote_target, "remoteUrl", cJSON_CreateString(url));
        assert(!remote_reboot.Stage(remote_plan));
    }
    cJSON_ReplaceItemInObject(remote_target, "remoteUrl", cJSON_CreateNumber(42));
    assert(!remote_reboot.Stage(remote_plan)); cJSON_Delete(remote_plan);
    durable = "broken NVS JSON"; BackendSelection corrupt;
    assert(!corrupt.HasPlan()); assert(corrupt.BeginAttempt().id.empty());
    std::cout << "Firmware routing state: commit, rollback, power loss, auto/fixed retry, NVS failures and validation passed\n";
}
