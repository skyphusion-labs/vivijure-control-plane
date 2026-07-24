# Vendored: the official AWS Signature Version 4 test suite

**Source:** `boto/botocore`, path `tests/unit/auth/aws4_testsuite/`
**Pinned commit:** `32302bc372dde1b6173b60f8b85d671e24a0d414`
**Retrieved:** 2026-07-25

AWS publishes this suite as the conformance vectors for SigV4. botocore (AWS's own SDK core) vendors
it with its LICENSE and NOTICE, both copied here unmodified alongside the cases.

## Why vendored rather than quoted

An earlier attempt to obtain these vectors from documentation returned values **recalled rather than
sourced** -- and they were WRONG: the recalled secret key read `...NG/bPxRfiCYEXAMPLEKEY` where the
real one is `...NG+bPxRfiCYEXAMPLEKEY`. One character, and every signature derived from it would
have been wrong while the test file claimed the authority of "the AWS published vectors".

A fabricated proof reads as stronger than no proof. So these files are copied byte-for-byte from a
pinned commit of AWS's own repository, and the credentials the suite signs with are read from that
same commit (`tests/unit/auth/test_sigv4.py`), not from memory:

    ACCESS_KEY = AKIDEXAMPLE
    SECRET_KEY = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
    REGION     = us-east-1
    SERVICE    = service

## File quartet per case

- `.req`   the raw HTTP request to sign
- `.creq`  the expected canonical request
- `.sts`   the expected string-to-sign
- `.authz` the expected Authorization header (contains the expected signature)
