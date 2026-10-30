CREATE TABLE "FeedbackImage" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "issueNumber" INTEGER,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackImage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FeedbackImage_size" CHECK (octet_length("bytes") <= 5242880),
    CONSTRAINT "FeedbackImage_type" CHECK ("contentType" IN ('image/png', 'image/jpeg', 'image/webp'))
);
