// Ceres is linked statically into crates/libmv-sys, so nothing is exported (Ceres's CMake normally generates this).
#ifndef CERES_EXPORT_H
#define CERES_EXPORT_H

#define CERES_EXPORT
#define CERES_NO_EXPORT

#endif  // CERES_EXPORT_H
