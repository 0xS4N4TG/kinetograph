// Ceres build configuration for crates/libmv-sys (written for Kinetograph; Ceres's CMake normally generates it).
// Only what libmv's region tracker needs: dense solvers on Eigen, no sparse back ends, no LAPACK, no GPU.
#ifndef CERES_PUBLIC_INTERNAL_CONFIG_H_
#define CERES_PUBLIC_INTERNAL_CONFIG_H_

#define CERES_NO_LAPACK
#define CERES_NO_SUITESPARSE
#define CERES_NO_CUDA
#define CERES_NO_ACCELERATE_SPARSE
#define CERES_NO_SPARSE
#define CERES_NO_CHOLMOD_PARTITION
#define CERES_NO_EIGEN_METIS
#define CERES_RESTRICT_SCHUR_SPECIALIZATION

#ifdef _MSC_VER
#define CERES_MSVC_USE_UNDERSCORE_PREFIXED_BESSEL_FUNCTIONS
#endif

#endif  // CERES_PUBLIC_INTERNAL_CONFIG_H_
