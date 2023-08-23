// Rename this to config.js and put your values

export const PORT = process.env.PORT || 3000;
export const config = {
    agencies: 
    [
        {url: "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip", exclude: ["shapes", "agency"]}
    ]
};