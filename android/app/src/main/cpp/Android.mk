LOCAL_PATH := $(call my-dir)
include $(CLEAR_VARS)
LOCAL_MODULE := node
LOCAL_SRC_FILES := ../../../../runtime/bin/$(TARGET_ARCH_ABI)/libnode.so
include $(PREBUILT_SHARED_LIBRARY)
include $(CLEAR_VARS)
LOCAL_MODULE := douli
LOCAL_SRC_FILES := bridge.cpp
LOCAL_SHARED_LIBRARIES := node
LOCAL_LDLIBS := -llog
include $(BUILD_SHARED_LIBRARY)
