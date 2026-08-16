### fix(provision): do not bind VIDEO_FINISH_VPC on tenant studios

Hosted finish is Traefik HTTPS. A leftover vpc_service on every new
studio was the 10196 unauthorized failure. mediaDoorUrls stay.
