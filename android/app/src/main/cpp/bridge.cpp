#include <jni.h>
#include <unistd.h>
#include <cstdlib>
#include <string>
#include <vector>
#include <fcntl.h>

namespace node { int Start(int argc, char* argv[]); }

extern "C" JNIEXPORT jint JNICALL
Java_cn_douli_app_EngineService_runNode(JNIEnv* env, jclass, jstring root, jstring data, jstring token) {
    auto str = [env](jstring value) {
        const char* chars = env->GetStringUTFChars(value, nullptr);
        std::string result(chars);
        env->ReleaseStringUTFChars(value, chars);
        return result;
    };
    auto codeDir = str(root), dataDir = str(data), stopToken = str(token);
    if (chdir(codeDir.c_str()) != 0) return 125;
    setenv("DOULI_DATA_DIR", dataDir.c_str(), 1);
    setenv("DOULI_MOBILE", "1", 1);
    setenv("DOULI_STOP_TOKEN", stopToken.c_str(), 1);
    // Private rotating-at-launch diagnostic log. Never included in an APK.
    int log = open((dataDir + "/engine.log").c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (log >= 0) { dup2(log, STDOUT_FILENO); dup2(log, STDERR_FILENO); close(log); }
    std::string script = codeDir + "/server/mobile.mjs";
    std::vector<char> args;
    for (const auto& arg : {std::string("node"), script}) {
        args.insert(args.end(), arg.begin(), arg.end()); args.push_back('\0');
    }
    char* argv[] = {args.data(), args.data() + 5};
    return node::Start(2, argv);
}
